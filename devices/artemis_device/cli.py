#!/usr/bin/env python3
"""Outbound Artemis device bridge. Python 3.10+, no third-party dependencies."""
import argparse
from contextlib import ExitStack
import getpass
import hashlib
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
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scopes import ScopeSettings, build_scopes
from .menu import AVAILABLE_SCOPES, select_scopes
from .transport import StdioMcp, interruptible_stream_events

def normalize_token(value):
    value = value.strip()
    # Some terminals include bracketed-paste markers when echo is disabled.
    if value.startswith('\x1b[200~') and value.endswith('\x1b[201~'):
        value = value[6:-6].strip()
    if value.startswith('ARTEMIS_DEVICE_TOKEN='):
        value = value.split('=', 1)[1].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1].strip()
    if not value or any(not c.isascii() or c.isspace() or ord(c) < 33 or ord(c) == 127 for c in value):
        raise ValueError('The device token is empty or contains whitespace/invisible characters. Copy only its value from ARTEMIS_DEVICE_TOKEN.')
    return value


def load_device_token(env_file=None):
    if env_file:
        candidates = [Path(env_file)]
    else:
        value = os.environ.get('ARTEMIS_DEVICE_TOKEN')
        if value and value.strip(): return normalize_token(value), 'ARTEMIS_DEVICE_TOKEN environment variable'
        candidates = [Path.cwd() / '.env', Path(__file__).resolve().parent.parent / '.env']
    for path in candidates:
        if not path.is_file():
            if env_file: raise ValueError(f'Token file not found: {path}')
            continue
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            stripped = line.strip()
            if stripped.startswith('export '): stripped = stripped[7:].lstrip()
            if '=' not in stripped: continue
            name, value = stripped.split('=', 1)
            if name.strip() == 'ARTEMIS_DEVICE_TOKEN' and value.strip():
                parts = shlex.split(value, comments=True)
                if not parts: continue
                if len(parts) != 1: raise ValueError(f'Invalid ARTEMIS_DEVICE_TOKEN line in {path}')
                return normalize_token(parts[0]), str(path.resolve())
        if env_file: raise ValueError(f'ARTEMIS_DEVICE_TOKEN is missing or empty in {path}')
    return normalize_token(getpass.getpass('Device token: ')), 'interactive input'


def upload_device_file(server, token, name, session, call_id, path):
    """Stream raw bytes over HTTP; return only server-generated file metadata."""
    with path.open('rb') as file:
        size = os.fstat(file.fileno()).st_size
        if size > 25 * 1024 * 1024: raise ValueError('File exceeds the 25 MB export limit')
        url = server.rstrip('/') + '/api/devices/' + urllib.parse.quote(name, safe='') + '/files/' + urllib.parse.quote(call_id, safe='')
        req = urllib.request.Request(url, data=file, method='POST', headers={
            'Authorization': 'Bearer ' + token, 'X-Device-Session': session,
            'Content-Type': 'application/octet-stream', 'Content-Length': str(size),
        })
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name', help='Unique device name: letters, numbers, underscores, hyphens')
    parser.add_argument('--server', default=os.environ.get('ARTEMIS_URL', 'http://127.0.0.1:3000'))
    parser.add_argument('--firefox', help='Firefox executable path')
    parser.add_argument('--scopes', nargs='+', choices=AVAILABLE_SCOPES, default=None, metavar='SCOPE', help='Scopes to expose (browser, media, filesystem, terminal, screenshot); omit for an interactive menu')
    parser.add_argument('--active-folder', default=str(Path.cwd()), metavar='PATH', help='Context folder described to the tools and used as the terminal starting directory (defaults to the current directory; not a filesystem restriction)')
    parser.add_argument('--env-file', help='Read ARTEMIS_DEVICE_TOKEN from this file instead of the environment or the project .env')
    parser.add_argument('--mcp-command', nargs=argparse.REMAINDER, help='Relay a local MCP stdio server instead of built-in scopes; put this option last')
    args = parser.parse_args()
    args.active_folder = Path(args.active_folder).expanduser().resolve()
    if not args.active_folder.is_dir(): parser.error('--active-folder must be an existing directory')
    if urllib.parse.urlsplit(args.server).scheme != 'https' and urllib.parse.urlsplit(args.server).hostname not in ('localhost', '127.0.0.1'):
        parser.error('Use HTTPS for remote servers')
    if args.scopes is None:
        if args.mcp_command:
            args.scopes = []
        else:
            try: args.scopes = select_scopes()
            except RuntimeError as error: parser.error(str(error))
    if args.mcp_command and args.scopes:
        parser.error('--mcp-command cannot be combined with built-in --scopes')
    try: scope_tools, scope_handlers = build_scopes(
        args.scopes,
        ScopeSettings(firefox=args.firefox, active_folder=args.active_folder),
    )
    except (OSError, RuntimeError, ValueError) as error: parser.error(str(error))
    try: token, token_source = load_device_token(args.env_file)
    except (ValueError, OSError) as error: parser.error(str(error))
    fingerprint = hashlib.sha256(token.encode()).hexdigest()[:12]
    print(f'Token source: {token_source} ({len(token)} characters, fingerprint {fingerprint}).', flush=True)
    server = args.server.rstrip('/')
    print(f'Connecting to Artemis at {server} as "{args.name}"...', flush=True)
    local = None
    local_stack = ExitStack()
    local_lock = threading.Lock()
    def local_client():
        nonlocal local
        if not args.mcp_command: return None
        with local_lock:
            if local is None or local._closed or local.process.poll() is not None:
                if local: local.close()
                print('Starting the local MCP server and loading its tools...', flush=True)
                local = local_stack.enter_context(StdioMcp(args.mcp_command))
            return local
    def open_request(path, body=None, session=None, timeout=35):
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if session: headers['X-Device-Session'] = session
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(server + '/api/devices/' + path, data=data, headers=headers)
        try: return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.artemis_endpoint = path
            raise
        except OSError as error:
            raise ConnectionError(f'{path}: {error}') from error
    def request(path, body=None, session=None, timeout=35):
        with open_request(path, body, session, timeout=timeout) as response:
            return json.load(response)
    def upload_file(path, call_id, active_session):
        return upload_device_file(server, token, args.name, active_session, call_id, path)
    def execute(message, active_session):
        try:
            if message.get('method') != 'tools/call': raise ValueError('Unsupported MCP method')
            params = message['params']
            active_local = local_client()
            if active_local: return active_local.rpc('tools/call', params)
            handler = scope_handlers.get(params['name'])
            if handler is None: raise ValueError('Unknown tool')
            if params['name'] == 'filesystem_export':
                return handler(params.get('arguments', {}), upload=lambda path: upload_file(path, message['id'], active_session))
            return handler(params.get('arguments', {}))
        except Exception as error:
            return {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
    device_path = urllib.parse.quote(args.name, safe='')
    session = None
    delay = 1
    stop_workers = threading.Event()
    requests_to_run = queue.Queue(maxsize=32)
    overload_responses = queue.Queue(maxsize=32)
    heartbeats = queue.Queue(maxsize=1)
    def execution_worker():
        while not stop_workers.is_set():
            try: message, active_session = requests_to_run.get(timeout=0.25)
            except queue.Empty: continue
            try:
                result = execute(message, active_session)
                request(device_path + '/results', {'jsonrpc': '2.0', 'id': message['id'], 'result': result}, active_session)
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                print(f'Unable to deliver tool result: {error}', flush=True)
            finally: requests_to_run.task_done()
    def heartbeat_worker():
        while not stop_workers.is_set():
            try: active_session = heartbeats.get(timeout=0.25)
            except queue.Empty: continue
            try: request(device_path + '/heartbeat', {}, active_session, timeout=10)
            except (OSError, ValueError) as error: print(f'Heartbeat failed: {error}', flush=True)
            finally: heartbeats.task_done()
    def overload_worker():
        while not stop_workers.is_set():
            try: message, active_session = overload_responses.get(timeout=0.25)
            except queue.Empty: continue
            try:
                result = {'isError': True, 'content': [{'type': 'text', 'text': 'Device is busy; request queue is full.'}]}
                request(device_path + '/results', {'jsonrpc': '2.0', 'id': message['id'], 'result': result}, active_session, timeout=10)
            except (OSError, ValueError, KeyError) as error: print(f'Unable to deliver busy response: {error}', flush=True)
            finally: overload_responses.task_done()
    for _ in range(4): threading.Thread(target=execution_worker, daemon=True).start()
    threading.Thread(target=heartbeat_worker, daemon=True).start()
    threading.Thread(target=overload_worker, daemon=True).start()
    try:
        while True:
            try:
                active_local = local_client()
                tools = active_local.tools() if active_local else scope_tools
                print(f'Registering device with Artemis ({len(tools)} tool(s))...', flush=True)
                session = request('register', {'name': args.name, 'tools': tools})['session']
                with open_request(device_path + '/events', session=session) as response:
                    for event, message in interruptible_stream_events(response):
                        if event == 'connected':
                            print(f'Connected: {args.name} ({len(tools)} tool(s)). Leave this window open.', flush=True)
                            delay = 1
                        elif event == 'ping':
                            try: heartbeats.put_nowait(session)
                            except queue.Full: pass
                        elif event == 'request':
                            try: requests_to_run.put_nowait((message, session))
                            except queue.Full:
                                try: overload_responses.put_nowait((message, session))
                                except queue.Full: print('Unable to queue busy response; pending call will expire.', flush=True)
                raise ConnectionError('Artemis closed the device connection')
            except urllib.error.HTTPError as error:
                endpoint = getattr(error, 'artemis_endpoint', 'unknown endpoint')
                try:
                    body = json.loads(error.read(4096))
                    detail = body.get('error', error.reason) if isinstance(body, dict) else error.reason
                except (ValueError, OSError): detail = error.reason
                if error.code == 401:
                    raise SystemExit(f'HTTP 401 at {endpoint}: {detail}. Token source: {token_source}; fingerprint: {fingerprint}. Check that this is the VPS ARTEMIS_DEVICE_TOKEN.')
                if error.code == 403:
                    raise SystemExit(f'HTTP 403 at {endpoint}: access blocked ({detail}). This response does not establish that the device token is wrong.')
                print(f'Artemis returned HTTP {error.code} at {endpoint} ({detail}); reconnecting in {delay}s.', flush=True)
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                print(f'Connection failed ({error}); retrying in {delay}s.', flush=True)
            finally:
                if session:
                    try: request(device_path + '/disconnect', {}, session, timeout=3)
                    except (OSError, ValueError): pass
                    session = None
            time.sleep(delay); delay = min(delay * 2, 30)
    except KeyboardInterrupt:
        print('Disconnected.', flush=True)
    finally:
        stop_workers.set()
        local_stack.close()

if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: print('Disconnected.', flush=True)
