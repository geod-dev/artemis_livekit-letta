#!/usr/bin/env python3
"""Outbound Artemis device bridge. Python 3.13, no third-party dependencies."""

import argparse
import contextlib
import getpass
import json
import os
import queue
import shlex
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .menu import select_scopes
from .scopes import AVAILABLE_SCOPES, ScopeSettings, build_scopes
from .scopes.filesystem import MAX_EXPORT_BYTES
from .transport import StdioMcp, interruptible_stream_events

DEVICE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_HOST = "127.0.0.1"
DEFAULT_GATEWAY_PORT = 3000
HTTP_TIMEOUT_SECONDS = 35
UPLOAD_TIMEOUT_SECONDS = 45
RESULT_TIMEOUT_SECONDS = 10
HEARTBEAT_TIMEOUT_SECONDS = 10
DISCONNECT_TIMEOUT_SECONDS = 3
REQUEST_QUEUE_SIZE = 32
EXECUTION_WORKERS = 4
MAX_RECONNECT_DELAY_SECONDS = 30
# A stream that stays up this long counts as healthy, so the next failure restarts the backoff.
STABLE_STREAM_SECONDS = 30
# Tools whose calls are written to stderr before they run, so the operator sees what is asked.
AUDITED_TOOLS = ("terminal_run", "filesystem_read", "filesystem_write", "filesystem_export")
AUDIT_LINE_LIMIT = 300
TOKEN_TAIL_MIN_LENGTH = 16


class _GatewayRedirectsRefused(urllib.request.HTTPRedirectHandler):
    """The device token and uploaded files go only to the configured gateway. Returning None
    lets the default error handler raise HTTPError for the 3xx response, so no hop is followed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_GATEWAY_OPENER = urllib.request.build_opener(_GatewayRedirectsRefused)


def stream_is_stable(connected_at, relayed):
    """A stream is stable once it has relayed a request or stayed up for the threshold. A bare
    connected event does not count: a gateway that accepts and then drops is not healthy."""
    if connected_at is None:
        return False
    return relayed or time.monotonic() - connected_at >= STABLE_STREAM_SECONDS


def normalize_token(value):
    value = value.strip()
    # Some terminals include bracketed-paste markers when echo is disabled.
    if value.startswith("\x1b[200~") and value.endswith("\x1b[201~"):
        value = value[6:-6].strip()
    if value.startswith("ARTEMIS_DEVICE_TOKEN="):
        value = value.split("=", 1)[1].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1].strip()
    if not value or any(
        not c.isascii() or c.isspace() or ord(c) < 33 or ord(c) == 127 for c in value
    ):
        raise ValueError(
            "The device token is empty or contains whitespace/invisible characters. Copy only its "
            "value from ARTEMIS_DEVICE_TOKEN."
        )
    return value


def dotenv_value(path, name):
    """Return one unquoted value from a dotenv-style file, or None when it is missing or unclear."""
    try:
        if not path.is_file():
            return None
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() == name:
            try:
                parts = shlex.split(value, comments=True)
            except ValueError:
                return None
            return parts[0] if len(parts) == 1 else None
    return None


def default_server():
    """Gateway URL when --server is omitted: ARTEMIS_URL, then IP_ADDRESS, from the environment
    or the repository-root .env (the environment wins for both)."""
    configured = os.environ.get("ARTEMIS_URL") or dotenv_value(REPO_ROOT / ".env", "ARTEMIS_URL")
    if configured:
        return configured
    host = (
        os.environ.get("IP_ADDRESS", "").strip()
        or dotenv_value(REPO_ROOT / ".env", "IP_ADDRESS")
        or DEFAULT_HOST
    )
    return f"http://{host}:{DEFAULT_GATEWAY_PORT}"


def load_device_token(env_file=None):
    if env_file:
        candidates = [Path(env_file)]
    else:
        value = os.environ.get("ARTEMIS_DEVICE_TOKEN")
        if value and value.strip():
            return normalize_token(value), "ARTEMIS_DEVICE_TOKEN environment variable"
        candidates = [REPO_ROOT / ".env", DEVICE_DIR / ".env"]
    for path in candidates:
        if not path.is_file():
            if env_file:
                raise ValueError(f"Token file not found: {path}")
            continue
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            stripped = line.strip()
            if stripped.startswith("export "):
                stripped = stripped[7:].lstrip()
            if "=" not in stripped:
                continue
            name, value = stripped.split("=", 1)
            if name.strip() == "ARTEMIS_DEVICE_TOKEN" and value.strip():
                parts = shlex.split(value, comments=True)
                if not parts:
                    continue
                if len(parts) != 1:
                    raise ValueError(f"Invalid ARTEMIS_DEVICE_TOKEN line in {path}")
                return normalize_token(parts[0]), str(path.resolve())
        if env_file:
            raise ValueError(f"ARTEMIS_DEVICE_TOKEN is missing or empty in {path}")
    return normalize_token(getpass.getpass("Device token: ")), "interactive input"


def token_tail(token):
    """The last four characters: enough to match a 401 to the token in use, not to reveal it."""
    return token[-4:] if len(token) >= TOKEN_TAIL_MIN_LENGTH else None


def upload_device_file(server, token, name, session, call_id, path):
    """Stream raw bytes over HTTP; return only server-generated file metadata."""
    with path.open("rb") as file:
        size = os.fstat(file.fileno()).st_size
        if size > MAX_EXPORT_BYTES:
            raise ValueError("File exceeds the 25 MB export limit")
        url = (
            server.rstrip("/")
            + "/api/devices/"
            + urllib.parse.quote(name, safe="")
            + "/files/"
            + urllib.parse.quote(call_id, safe="")
        )
        req = urllib.request.Request(
            url,
            data=file,
            method="POST",
            headers={
                "Authorization": "Bearer " + token,
                "X-Device-Session": session,
                "Content-Type": "application/octet-stream",
                "Content-Length": str(size),
            },
        )
        with _GATEWAY_OPENER.open(req, timeout=UPLOAD_TIMEOUT_SECONDS) as response:
            return json.load(response)


def is_request(message):
    """A relayed request must be a JSON-RPC object with an id, or its result cannot be returned."""
    return isinstance(message, dict) and "id" in message


def audit(tool, arguments):
    """Write one line to stderr describing a tool call; file contents are never logged."""
    if not isinstance(arguments, dict):
        arguments = {}
    if tool == "terminal_run":
        detail = f"command={arguments.get('command')!r} cwd={arguments.get('cwd')!r}"
    else:
        detail = f"path={arguments.get('path')!r}"
    line = f"[audit] {tool} {detail}"
    if len(line) > AUDIT_LINE_LIMIT:
        line = line[:AUDIT_LINE_LIMIT] + "..."
    print(line, file=sys.stderr, flush=True)


class DeviceSession:
    """One device registration: relays Artemis tool calls to the scopes or a local MCP server."""

    def __init__(
        self,
        *,
        name,
        server,
        token,
        token_source,
        token_hint,
        scope_tools,
        scope_handlers,
        mcp_command,
    ):
        self.name = name
        self.server = server
        self.token = token
        self.token_source = token_source
        self.token_hint = token_hint
        self.scope_tools = scope_tools
        self.scope_handlers = scope_handlers
        self.mcp_command = mcp_command
        self.device_path = urllib.parse.quote(name, safe="")
        self.local = None
        self.local_lock = threading.Lock()
        self.stop_workers = threading.Event()
        self.requests_to_run = queue.Queue(maxsize=REQUEST_QUEUE_SIZE)
        self.overload_responses = queue.Queue(maxsize=REQUEST_QUEUE_SIZE)
        self.heartbeats = queue.Queue(maxsize=1)

    def close(self):
        self.stop_workers.set()
        with self.local_lock:
            if self.local is not None:
                self.local.close()

    def local_client(self):
        if not self.mcp_command:
            return None
        with self.local_lock:
            if self.local is None or self.local.is_closed or self.local.process.poll() is not None:
                if self.local is not None:
                    # Each restart closes the previous server through its own handle, so the
                    # number of open handles does not grow with restarts.
                    self.local.close()
                print("Starting the local MCP server and loading its tools...", flush=True)
                self.local = StdioMcp(self.mcp_command)
            return self.local

    def open_request(self, path, body=None, session=None, timeout=HTTP_TIMEOUT_SECONDS):
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}
        if session:
            headers["X-Device-Session"] = session
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.server + "/api/devices/" + path, data=data, headers=headers
        )
        try:
            return _GATEWAY_OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.artemis_endpoint = path
            raise
        except OSError as error:
            raise ConnectionError(f"{path}: {error}") from error

    def request(self, path, body=None, session=None, timeout=HTTP_TIMEOUT_SECONDS):
        with self.open_request(path, body, session, timeout=timeout) as response:
            return json.load(response)

    def upload_file(self, path, call_id, active_session):
        return upload_device_file(self.server, self.token, self.name, active_session, call_id, path)

    def execute(self, message, active_session):
        try:
            if message.get("method") != "tools/call":
                raise ValueError("Unsupported MCP method")
            params = message["params"]
            active_local = self.local_client()
            if active_local:
                # Relayed calls are audited before they run, the same as built-in scopes.
                if params.get("name") in AUDITED_TOOLS:
                    audit(params["name"], params.get("arguments", {}))
                return active_local.rpc("tools/call", params)
            tool = params["name"]
            handler = self.scope_handlers.get(tool)
            if handler is None:
                raise ValueError("Unknown tool")
            arguments = params.get("arguments", {})
            if tool in AUDITED_TOOLS:
                audit(tool, arguments)
            if tool == "filesystem_export":
                return handler(
                    arguments,
                    upload=lambda path: self.upload_file(path, message["id"], active_session),
                )
            return handler(arguments)
        except Exception as error:
            return {"isError": True, "content": [{"type": "text", "text": str(error)}]}

    def _execution_worker(self):
        while not self.stop_workers.is_set():
            try:
                message, active_session = self.requests_to_run.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                result = self.execute(message, active_session)
                self.request(
                    self.device_path + "/results",
                    {"jsonrpc": "2.0", "id": message["id"], "result": result},
                    active_session,
                    timeout=HTTP_TIMEOUT_SECONDS,
                )
            except Exception as error:
                # Any failure is logged; the worker survives to serve the next call.
                print(f"Unable to deliver tool result: {error}", flush=True)
            finally:
                self.requests_to_run.task_done()

    def _heartbeat_worker(self):
        while not self.stop_workers.is_set():
            try:
                active_session = self.heartbeats.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                self.request(
                    self.device_path + "/heartbeat",
                    {},
                    active_session,
                    timeout=HEARTBEAT_TIMEOUT_SECONDS,
                )
            except Exception as error:
                print(f"Heartbeat failed: {error}", flush=True)
            finally:
                self.heartbeats.task_done()

    def _overload_worker(self):
        while not self.stop_workers.is_set():
            try:
                message, active_session = self.overload_responses.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                result = {
                    "isError": True,
                    "content": [{"type": "text", "text": "Device is busy; request queue is full."}],
                }
                self.request(
                    self.device_path + "/results",
                    {"jsonrpc": "2.0", "id": message["id"], "result": result},
                    active_session,
                    timeout=RESULT_TIMEOUT_SECONDS,
                )
            except Exception as error:
                print(f"Unable to deliver busy response: {error}", flush=True)
            finally:
                self.overload_responses.task_done()

    def _start_workers(self):
        for _ in range(EXECUTION_WORKERS):
            threading.Thread(target=self._execution_worker, daemon=True).start()
        threading.Thread(target=self._heartbeat_worker, daemon=True).start()
        threading.Thread(target=self._overload_worker, daemon=True).start()

    def serve(self):
        """Stay connected, reconnecting with backoff, until interrupted or refused."""
        self._start_workers()
        session = None
        delay = 1
        while True:
            connected_at = None
            try:
                active_local = self.local_client()
                tools = active_local.tools() if active_local else self.scope_tools
                print(f"Registering device with Artemis ({len(tools)} tool(s))...", flush=True)
                session = self.request("register", {"name": self.name, "tools": tools})["session"]
                with self.open_request(self.device_path + "/events", session=session) as response:
                    for event, message in interruptible_stream_events(response):
                        if stream_is_stable(connected_at, relayed=event == "request"):
                            delay = 1
                        if event == "connected":
                            print(
                                f"Connected: {self.name} ({len(tools)} tool(s)). Leave this window "
                                f"open.",
                                flush=True,
                            )
                            connected_at = time.monotonic()
                        elif event == "ping":
                            with contextlib.suppress(queue.Full):
                                self.heartbeats.put_nowait(session)
                        elif event == "request":
                            if not is_request(message):
                                print(
                                    "Ignoring a malformed request (expected a JSON-RPC object "
                                    "with an id).",
                                    flush=True,
                                )
                                continue
                            try:
                                self.requests_to_run.put_nowait((message, session))
                            except queue.Full:
                                try:
                                    self.overload_responses.put_nowait((message, session))
                                except queue.Full:
                                    print(
                                        "Unable to queue busy response; pending call will expire.",
                                        flush=True,
                                    )
                if stream_is_stable(connected_at, relayed=False):
                    delay = 1
                raise ConnectionError("Artemis closed the device connection")
            except urllib.error.HTTPError as error:
                endpoint = getattr(error, "artemis_endpoint", "unknown endpoint")
                try:
                    body = json.loads(error.read(4096))
                    detail = (
                        body.get("error", error.reason) if isinstance(body, dict) else error.reason
                    )
                except (ValueError, OSError):
                    detail = error.reason
                if error.code == 401:
                    tail_note = f'; token ends with "{self.token_hint}"' if self.token_hint else ""
                    raise SystemExit(
                        f"HTTP 401 at {endpoint}: {detail}. Token source: "
                        f"{self.token_source}{tail_note}. Check that this is the VPS "
                        f"ARTEMIS_DEVICE_TOKEN."
                    ) from error
                if error.code == 403:
                    raise SystemExit(
                        f"HTTP 403 at {endpoint}: access blocked ({detail}). This response does "
                        f"not establish that the device token is wrong."
                    ) from error
                if error.code == 410:
                    # The gateway ended this registration (its lease expired): register again.
                    delay = 1
                    print(
                        f"Session expired (HTTP 410 at {endpoint}); registering again in {delay}s.",
                        flush=True,
                    )
                elif error.code == 409:
                    # Another live connection holds this name. Reported, then retried with backoff.
                    print(
                        f'Device name "{self.name}" is already connected to Artemis (HTTP 409 at '
                        f"{endpoint}). Stop the other client or choose another name; retrying in "
                        f"{delay}s.",
                        flush=True,
                    )
                else:
                    print(
                        f"Artemis returned HTTP {error.code} at {endpoint} ({detail}); "
                        f"reconnecting in {delay}s.",
                        flush=True,
                    )
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                print(f"Connection failed ({error}); retrying in {delay}s.", flush=True)
            finally:
                if session:
                    with contextlib.suppress(OSError, ValueError):
                        self.request(
                            self.device_path + "/disconnect",
                            {},
                            session,
                            timeout=DISCONNECT_TIMEOUT_SECONDS,
                        )
                    session = None
            time.sleep(delay)
            delay = min(delay * 2, MAX_RECONNECT_DELAY_SECONDS)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="Unique device name: letters, numbers, underscores, hyphens")
    parser.add_argument("--server", default=default_server())
    parser.add_argument("--firefox", help="Firefox executable path")
    parser.add_argument(
        "--scopes",
        nargs="+",
        choices=AVAILABLE_SCOPES,
        default=None,
        metavar="SCOPE",
        help="Scopes to expose (browser, media, filesystem, terminal, screenshot); omit for an "
        "interactive menu",
    )
    parser.add_argument(
        "--active-folder",
        default=str(Path.cwd()),
        metavar="PATH",
        help="Context folder described to the tools and used as the terminal starting directory "
        "(defaults to the current directory; not a filesystem restriction)",
    )
    parser.add_argument(
        "--env-file",
        help="Read ARTEMIS_DEVICE_TOKEN from this file instead of the environment or the repo or "
        "device .env files",
    )
    parser.add_argument(
        "--mcp-command",
        nargs=argparse.REMAINDER,
        help="Relay a local MCP stdio server instead of built-in scopes; put this option last",
    )
    parser.add_argument(
        "--verbose-auth",
        action="store_true",
        help="Also print the last four characters of the device token (diagnostics only)",
    )
    return parser


def parse_args(argv=None, parser=None):
    """Parse and validate the command line; argv defaults to sys.argv[1:]."""
    parser = parser or build_parser()
    args = parser.parse_args(argv)
    args.active_folder = Path(args.active_folder).expanduser().resolve()
    if not args.active_folder.is_dir():
        parser.error("--active-folder must be an existing directory")
    server = urllib.parse.urlsplit(args.server)
    if server.scheme != "https" and server.hostname not in ("localhost", "127.0.0.1"):
        # The default comes from ARTEMIS_URL or IP_ADDRESS; a remote one must be named explicitly.
        parser.error(
            "Plain HTTP is accepted only for localhost and 127.0.0.1. Pass --server "
            f"https://<gateway> for a remote gateway (got {args.server!r})."
        )
    if args.mcp_command and args.scopes:
        parser.error("--mcp-command cannot be combined with built-in --scopes")
    if args.scopes is None:
        if args.mcp_command:
            args.scopes = []
        else:
            try:
                args.scopes = select_scopes()
            except RuntimeError as error:
                parser.error(str(error))
    return args


def run(argv=None):
    """Entry point: parse options, load scopes and the token, then serve until interrupted."""
    parser = build_parser()
    args = parse_args(argv, parser)
    try:
        scope_tools, scope_handlers = build_scopes(
            args.scopes,
            ScopeSettings(firefox=args.firefox, active_folder=args.active_folder),
        )
    except (OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))
    try:
        token, token_source = load_device_token(args.env_file)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    # The token itself stays out of routine output; its last four characters are opt-in.
    token_hint = token_tail(token) if args.verbose_auth else None
    hint_text = f', ends with "{token_hint}"' if token_hint else ""
    print(f"Token source: {token_source} ({len(token)} characters{hint_text}).", flush=True)
    server = args.server.rstrip("/")
    print(f'Connecting to Artemis at {server} as "{args.name}"...', flush=True)
    session = DeviceSession(
        name=args.name,
        server=server,
        token=token,
        token_source=token_source,
        token_hint=token_hint,
        scope_tools=scope_tools,
        scope_handlers=scope_handlers,
        mcp_command=args.mcp_command,
    )
    try:
        session.serve()
    finally:
        session.close()


def main():
    """Run the client. Ctrl+C disconnects cleanly, in the menu or while connected."""
    try:
        run()
    except KeyboardInterrupt:
        print("Disconnected.", flush=True)
