import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from artemis_device import cli as device


class DeviceTest(unittest.TestCase):
    def test_macos_media_actions_do_not_require_volume(self):
        from types import SimpleNamespace

        from artemis_device.scopes import media

        actions = ("play", "pause", "play_pause", "info", "volume_up", "volume_down")
        with (
            patch.object(media.sys, "platform", "darwin"),
            patch.object(media.shutil, "which", return_value="osascript"),
        ):
            _, handlers = media.register(SimpleNamespace())
            for action in actions:
                with (
                    self.subTest(action=action),
                    patch.object(
                        media.subprocess,
                        "run",
                        return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
                    ) as run,
                ):
                    handlers["media_control"]({"action": action})
                    self.assertEqual(run.call_args.args[0][0], "osascript")
            with patch.object(
                media.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
            ) as run:
                handlers["media_control"]({"action": "volume", "volume": 42.6})
                self.assertIn("43", run.call_args.args[0][-1])

    def test_terminal_shell_lines_spaces_quotes_and_pipes(self):
        from types import SimpleNamespace

        from artemis_device.scopes.terminal import register

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file with spaces.txt"
            path.write_text("quoted-path-content", encoding="utf-8")
            _, handlers = register(SimpleNamespace(active_folder=directory))
            commands = [
                "Write-Output 'été with spaces' | ForEach-Object { $_ }"
                if os.name == "nt"
                else "printf 'été with spaces' | cat",
                "Get-Content 'file with spaces.txt'"
                if os.name == "nt"
                else "cat 'file with spaces.txt'",
            ]
            for command, expected in zip(
                commands, ["été with spaces", "quoted-path-content"], strict=False
            ):
                result = handlers["terminal_run"]({"command": command, "arguments": []})
                self.assertIn("exit_code: 0", result["content"][0]["text"])
                self.assertIn(expected, result["content"][0]["text"])
            result = handlers["terminal_run"](
                {
                    "command": sys.executable,
                    "arguments": [
                        "-c",
                        "import sys; print(sys.argv[1])",
                        "literal & $value | argument",
                    ],
                }
            )
            self.assertIn("literal & $value | argument", result["content"][0]["text"])

    def test_terminal_can_run_and_read_outside_active_folder(self):
        from types import SimpleNamespace

        from artemis_device.scopes.terminal import register

        with tempfile.TemporaryDirectory() as directory:
            active = Path(directory) / "active"
            outside = Path(directory) / "other"
            active.mkdir()
            outside.mkdir()
            (outside / "example.txt").write_text("outside-folder-access", encoding="utf-8")
            tools, handlers = register(SimpleNamespace(active_folder=str(active)))
            self.assertIn("system-wide", tools[0]["description"])
            result = handlers["terminal_run"](
                {
                    "command": sys.executable,
                    "arguments": [
                        "-c",
                        "from pathlib import Path; print(Path('example.txt').read_text())",
                    ],
                    "cwd": str(outside),
                }
            )
            self.assertIn("exit_code: 0", result["content"][0]["text"])
            self.assertIn("outside-folder-access", result["content"][0]["text"])
            result = handlers["terminal_run"](
                {
                    "command": sys.executable,
                    "arguments": [
                        "-c",
                        "from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text())",
                        str(outside / "example.txt"),
                    ],
                }
            )
            self.assertIn("outside-folder-access", result["content"][0]["text"])

    def test_device_upload_streams_exact_binary_bytes_over_http(self):
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received["path"] = self.path
                received["auth"] = self.headers["Authorization"]
                received["session"] = self.headers["X-Device-Session"]
                received["body"] = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"path": "data/device-files/id/rib.pdf"}).encode())

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "rib.pdf"
                payload = bytes(range(256)) * 1000
                path.write_bytes(payload)
                result = device.upload_device_file(
                    f"http://127.0.0.1:{server.server_port}",
                    "test-token",
                    "pc",
                    "session",
                    "call-id",
                    path,
                )
                self.assertEqual(received["body"], payload)
                self.assertEqual(received["auth"], "Bearer test-token")
                self.assertEqual(received["session"], "session")
                self.assertEqual(received["path"], "/api/devices/pc/files/call-id")
                self.assertEqual(result, {"path": "data/device-files/id/rib.pdf"})
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_filesystem_export_returns_metadata_without_reading_binary_into_context(self):
        from types import SimpleNamespace

        from artemis_device.scopes.filesystem import register

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rib.pdf"
            payload = b"%PDF-1.7\n\x00\xff\x80binary"
            path.write_bytes(payload)
            tools, handlers = register(SimpleNamespace(active_folder=directory))
            self.assertIn("filesystem_export", [tool["name"] for tool in tools])
            metadata = {"path": "data/device-files/id/rib.pdf", "size": len(payload)}

            def upload(source):
                self.assertEqual(source.read_bytes(), payload)
                return metadata

            result = handlers["filesystem_export"]({"path": str(path)}, upload)
            self.assertNotIn("binary", result["content"][0]["text"])
            self.assertIn(metadata["path"], result["content"][0]["text"])
            with self.assertRaises(ValueError):
                handlers["filesystem_export"]({"path": "relative.pdf"}, upload)
            with self.assertRaises(ValueError):
                handlers["filesystem_read"]({"path": str(path)})

    def test_token_paste_normalization(self):
        for pasted in [
            "  demo-token\n",
            '"demo-token"',
            "ARTEMIS_DEVICE_TOKEN='demo-token'",
            "\x1b[200~demo-token\x1b[201~",
        ]:
            self.assertEqual(device.normalize_token(pasted), "demo-token")
        for pasted in ["", "demo token", "demo\u200btoken"]:
            with self.assertRaises(ValueError):
                device.normalize_token(pasted)

    def test_token_file_overrides_stale_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                'OTHER_KEY=ignored\nARTEMIS_DEVICE_TOKEN="file-token" # device credential\n'
            )
            with patch.dict(os.environ, {"ARTEMIS_DEVICE_TOKEN": "stale-token"}):
                self.assertEqual(
                    device.load_device_token(str(path)), ("file-token", str(path.resolve()))
                )
                self.assertEqual(device.load_device_token()[0], "stale-token")
            with self.assertRaises(ValueError):
                device.load_device_token(str(path.parent / "missing"))

    def test_persistent_connection_events(self):
        from artemis_device.transport import stream_events

        response = io.BytesIO(
            b'event: connected\ndata: {"name":"laptop"}\n\nevent: ping\ndata: {}\n\nevent: request\ndata: {"id":"1",\ndata: "method":"tools/call"}\n\n'
        )
        self.assertEqual(
            list(stream_events(response)),
            [
                ("connected", {"name": "laptop"}),
                ("ping", {}),
                ("request", {"id": "1", "method": "tools/call"}),
            ],
        )

    def test_firefox_uses_arguments_without_shell(self):
        from artemis_device.scopes.browser import open_url

        with patch("artemis_device.scopes.browser.subprocess.Popen") as popen:
            result = open_url({"url": "https://example.com/?x=a&y=b"}, "firefox")
            self.assertIn("Opened", result["content"][0]["text"])
            self.assertEqual(
                popen.call_args.args[0], ["firefox", "--new-tab", "https://example.com/?x=a&y=b"]
            )
            self.assertNotIn("shell", popen.call_args.kwargs)

    def test_rejects_unsafe_urls(self):
        from artemis_device.scopes.browser import open_url

        for url in [
            "file:///tmp/private",
            "javascript:alert(1)",
            "--help",
            "https://",
            "https://example.com/\n",
        ]:
            with self.assertRaises(ValueError):
                open_url({"url": url}, "firefox")

    def test_browser_owns_open_url_handler(self):
        from types import SimpleNamespace

        from artemis_device.scopes.browser import open_url, register

        _tools, handlers = register(SimpleNamespace(firefox="firefox"))
        self.assertIn("open_url", handlers)
        with patch("artemis_device.scopes.browser.subprocess.Popen") as popen:
            self.assertIn(
                "Opened", open_url({"url": "https://example.com"}, "firefox")["content"][0]["text"]
            )
            self.assertEqual(
                popen.call_args.args[0], ["firefox", "--new-tab", "https://example.com"]
            )

    def test_stdio_mcp(self):
        script = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' in m:\n  result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]} if m['method']=='tools/list' else {'content':[{'type':'text','text':'ok'}]}\n  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)"
        server = device.StdioMcp([sys.executable, "-u", "-c", script])
        try:
            self.assertEqual(server.tools()[0]["name"], "echo")
            self.assertEqual(server.rpc("tools/call", {"name": "echo"})["content"][0]["text"], "ok")
        finally:
            server.close()

    def test_stdio_mcp_preserves_unrelated_responses(self):
        from artemis_device.transport import StdioMcp

        script = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n if m['method']=='initialize': r={}\n elif m['method']=='tools/list':\n  print(json.dumps({'jsonrpc':'2.0','id':3,'result':{'content':[{'type':'text','text':'saved'}]}}),flush=True); r={'tools':[]}\n else: r={'content':[{'type':'text','text':'actual'}]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with StdioMcp([sys.executable, "-u", "-c", script]) as server:
            self.assertEqual(server.tools(), [])
            self.assertEqual(server.rpc("tools/call", {})["content"][0]["text"], "saved")

    def test_stdio_mcp_timeout_is_explicit_and_closes_process(self):
        from artemis_device.transport import StdioMcp

        script = "import sys,json,time\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{}}),flush=True); time.sleep(30)"
        server = StdioMcp([sys.executable, "-u", "-c", script], timeout=2)
        server.timeout = 0.05
        with self.assertRaisesRegex(TimeoutError, "tools/list request timed out"):
            server.rpc("tools/list", {})
        self.assertTrue(server._closed)
        self.assertIsNotNone(server.process.poll())
        self.assertFalse(server._reader_thread.is_alive())

    def test_stdio_mcp_close_unblocks_full_stdout_queue_and_joins_reader(self):
        script = "import sys,json\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{}}),flush=True); sys.stdin.readline(); [print(json.dumps({'jsonrpc':'2.0','method':'notifications/progress','params':{}}),flush=True) for _ in range(200)]"
        server = device.StdioMcp([sys.executable, "-u", "-c", script], timeout=2)
        try:
            deadline = time.monotonic() + 3
            while server.messages.qsize() < server.messages.maxsize and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(server.messages.qsize(), server.messages.maxsize)
        finally:
            server.close()
        self.assertIsNotNone(server.process.poll())
        self.assertFalse(server._reader_thread.is_alive())
        server.close()

    def test_stdio_mcp_eof_with_full_queue_finishes_reader_without_sentinel(self):
        script = "import sys,json\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{}}),flush=True); sys.stdin.readline(); [print(json.dumps({'jsonrpc':'2.0','method':'notifications/progress','params':{}}),flush=True) for _ in range(128)]"
        server = device.StdioMcp([sys.executable, "-u", "-c", script], timeout=2)
        try:
            deadline = time.monotonic() + 3
            while server.process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNotNone(server.process.poll())
            self.assertTrue(server._reader_done.wait(timeout=2))
            server._reader_thread.join(timeout=1)
            self.assertFalse(server._reader_thread.is_alive())
        finally:
            server.close()

    def test_stdio_mcp_rejects_repeated_tool_cursor_and_tool_overflow(self):
        repeated = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n r={} if m['method']=='initialize' else {'tools':[],'nextCursor':'again'}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with device.StdioMcp([sys.executable, "-u", "-c", repeated]) as server:
            with self.assertRaisesRegex(RuntimeError, "repeated pagination cursor"):
                server.tools()
            self.assertTrue(server._closed)
        oversized = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n r={} if m['method']=='initialize' else {'tools':[{} for _ in range(101)]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with (
            device.StdioMcp([sys.executable, "-u", "-c", oversized]) as server,
            self.assertRaisesRegex(RuntimeError, "more than 100 tools"),
        ):
            server.tools()
        endless = "import sys,json\npages=0\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n if m['method']=='initialize': r={}\n else:\n  pages+=1; r={'tools':[],'nextCursor':str(pages)}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with (
            device.StdioMcp([sys.executable, "-u", "-c", endless]) as server,
            self.assertRaisesRegex(RuntimeError, "exceeded 100 pages"),
        ):
            server.tools()

    def test_sse_reader_closes_and_joins_when_event_queue_is_full(self):
        from artemis_device.transport import interruptible_stream_events

        class FloodResponse:
            def __init__(self):
                self.closed = threading.Event()
                self.yielded = 0

            def __iter__(self):
                while not self.closed.is_set():
                    self.yielded += 1
                    yield b"event: ping\n"
                    self.yielded += 1
                    yield b"data: {}\n"
                    self.yielded += 1
                    yield b"\n"

            def close(self):
                self.closed.set()

        response = FloodResponse()
        events = interruptible_stream_events(response)
        self.assertEqual(next(events), ("ping", {}))
        deadline = time.monotonic() + 2
        while response.yielded < 100 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(response.yielded, 100)
        events.close()
        self.assertFalse(any(t.name == "artemis-sse-reader" for t in threading.enumerate()))

    def test_stdio_mcp_initialization_failure_cleans_up_process(self):
        script = "import sys,json,time\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'error':{'code':-1,'message':'no'}}),flush=True); time.sleep(30)"
        with self.assertRaises(RuntimeError):
            device.StdioMcp([sys.executable, "-u", "-c", script], timeout=1)

    def test_terminal_reports_truncated_output(self):
        from types import SimpleNamespace

        from artemis_device.scopes.terminal import register

        with tempfile.TemporaryDirectory() as directory:
            _, handlers = register(SimpleNamespace(active_folder=directory))
            command = [sys.executable, "-c", 'print("x" * 70000)']
            result = handlers["terminal_run"]({"command": command[0], "arguments": command[1:]})[
                "content"
            ][0]["text"]
            self.assertIn("[stdout truncated at 64 KB]", result)


class ReviewFixTests(unittest.TestCase):
    """Boundary fixes: env resolution, plain-HTTP rule, MCP and SSE input, relay audit, restarts,
    atomic writes, incomplete terminal output, and the scope list."""

    def _session(self, mcp_command=None):
        return device.DeviceSession(
            name="laptop",
            server="http://127.0.0.1:1",
            token="t",
            token_source="test",
            token_hint=None,
            scope_tools=[],
            scope_handlers={},
            mcp_command=mcp_command,
        )

    def test_default_server_reads_artemis_url_from_the_root_dotenv(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / ".env").write_text(
                "ARTEMIS_URL=https://from-dotenv.example.test\n", encoding="utf-8"
            )
            with (
                patch.object(device, "REPO_ROOT", Path(directory)),
                patch.dict(os.environ, {}),
            ):
                os.environ.pop("ARTEMIS_URL", None)
                self.assertEqual(device.default_server(), "https://from-dotenv.example.test")
                os.environ["ARTEMIS_URL"] = "https://from-env.example.test"
                self.assertEqual(device.default_server(), "https://from-env.example.test")

    def test_plain_http_is_accepted_only_for_the_exact_loopback_names(self):
        for url in ("http://localhost:3000", "http://127.0.0.1:3000"):
            args = device.parse_args(["laptop", "--server", url, "--scopes", "browser"])
            self.assertEqual(args.server, url)
        for url in ("http://[::1]:3000", "http://gateway:3000", "http://192.168.1.20:3000"):
            with (
                self.subTest(url=url),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as caught,
            ):
                device.parse_args(["laptop", "--server", url, "--scopes", "browser"])
            self.assertEqual(caught.exception.code, 2)

    def test_non_object_json_from_the_local_server_is_discarded(self):
        child = (
            "import sys,json\n"
            "for line in sys.stdin:\n"
            " m=json.loads(line)\n"
            " if 'id' not in m: continue\n"
            " for junk in ('42','null','[1]','\"x\"'): print(junk, flush=True)\n"
            " r={} if m['method']=='initialize' else {'tools':[{'name':'t'}]}\n"
            " print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)\n"
        )
        with (
            redirect_stderr(io.StringIO()) as stderr,
            device.StdioMcp([sys.executable, "-u", "-c", child]) as server,
        ):
            tools = server.tools()
        self.assertEqual(tools, [{"name": "t"}])
        self.assertEqual(stderr.getvalue().count("non-object JSON"), 1)

    def test_relayed_tool_calls_are_audited_before_they_run(self):
        session = self._session(mcp_command=["unused"])
        calls = []
        session.local = SimpleNamespace(
            is_closed=False,
            process=SimpleNamespace(poll=lambda: None),
            rpc=lambda method, params: calls.append(params) or {"content": []},
        )
        message = {
            "id": 1,
            "method": "tools/call",
            "params": {"name": "terminal_run", "arguments": {"command": "echo hi"}},
        }
        with redirect_stderr(io.StringIO()) as stderr:
            session.execute(message, "session")
        self.assertIn("[audit] terminal_run command='echo hi'", stderr.getvalue())
        self.assertEqual(len(calls), 1)

    def test_restarting_the_local_server_closes_the_previous_one(self):
        created = []

        class FakeMcp:
            def __init__(self, command):
                self.is_closed = False
                self.process = SimpleNamespace(poll=lambda: None)
                self.closed_count = 0
                created.append(self)

            def close(self):
                self.is_closed = True
                self.closed_count += 1

        session = self._session(mcp_command=["fake"])
        with patch.object(device, "StdioMcp", FakeMcp), redirect_stdout(io.StringIO()):
            for _ in range(5):
                session.local_client().is_closed = True  # the server crashed
            session.close()
        self.assertEqual(len(created), 5)
        self.assertEqual([server.closed_count for server in created], [1, 1, 1, 1, 1])
        self.assertFalse(hasattr(session, "local_stack"))

    def test_malformed_sse_event_is_skipped_without_ending_the_stream(self):
        from artemis_device.transport import stream_events

        response = io.BytesIO(b"event: request\ndata: {bad json\n\nevent: ping\ndata: {}\n\n")
        with redirect_stdout(io.StringIO()) as out:
            events = list(stream_events(response))
        self.assertEqual(events, [("ping", {})])
        self.assertIn("malformed 'request' event", out.getvalue())

    def test_failed_filesystem_write_leaves_the_old_file_and_no_temp_file(self):
        from artemis_device.scopes import filesystem

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "notes.txt"
            target.write_text("old", encoding="utf-8")
            _, handlers = filesystem.register(SimpleNamespace(active_folder=directory))
            with (
                patch.object(filesystem.os, "replace", side_effect=OSError("disk full")),
                self.assertRaises(OSError),
            ):
                handlers["filesystem_write"]({"path": str(target), "content": "new"})
            self.assertEqual(target.read_text(encoding="utf-8"), "old")
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["notes.txt"])

    def test_terminal_reports_incomplete_output_when_a_child_keeps_the_pipe_open(self):
        from artemis_device.scopes.terminal import register

        # The grandchild inherits stdout (close_fds=False) and outlives the command.
        code = (
            "import subprocess,sys\n"
            "subprocess.Popen([sys.executable,'-c','import time; time.sleep(4)'],"
            "close_fds=False)\n"
            "print('started')\n"
        )
        # The surviving grandchild keeps the working directory open on Windows, so cleanup may
        # have to skip it.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            _, handlers = register(SimpleNamespace(active_folder=directory))
            result = handlers["terminal_run"](
                {"command": sys.executable, "arguments": ["-c", code]}
            )
        text = result["content"][0]["text"]
        self.assertIn("started", text)
        self.assertIn("output incomplete", text)

    def test_screenshot_failure_reports_the_tool_stderr(self):
        from artemis_device.scopes import screenshot

        with self.assertRaisesRegex(RuntimeError, "no display here"):
            screenshot._run_capture_tool(
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stderr.write('no display here\\n'); sys.exit(1)",
                ]
            )

    def test_menu_and_cli_share_one_scope_list(self):
        from artemis_device.menu import AVAILABLE_SCOPES as MENU_SCOPES
        from artemis_device.scopes import SCOPE_MODULES

        self.assertEqual(MENU_SCOPES, tuple(SCOPE_MODULES))
        self.assertEqual(device.AVAILABLE_SCOPES, tuple(SCOPE_MODULES))


class MainLoopTests(unittest.TestCase):
    """main() against a fake Artemis: register, auth failures, reconnect, token output."""

    TOKEN = "test-token-value"

    def _fake_artemis(self, statuses):
        """Answer each register call with the next status code; record the requests."""
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(self.path)
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                status = statuses[min(len(seen), len(statuses)) - 1]
                body = json.dumps({"error": "rejected by fake server"}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return None

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, seen

    def _run_main(self, server, *extra, sleep_side_effect=KeyboardInterrupt):
        """Run main() with patched argv and a token file; return (stdout, raised exception)."""
        temp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, temp, True)
        env_file = Path(temp) / "token.env"
        env_file.write_text(f"ARTEMIS_DEVICE_TOKEN={self.TOKEN}\n", encoding="utf-8")
        url = f"http://127.0.0.1:{server.server_address[1]}"
        argv = [
            "artemis-device",
            "laptop",
            "--server",
            url,
            "--scopes",
            "browser",
            "--env-file",
            str(env_file),
            *extra,
        ]
        out = io.StringIO()
        error = None
        with (
            patch.object(sys, "argv", argv),
            redirect_stdout(out),
            patch("artemis_device.cli.time.sleep", side_effect=sleep_side_effect) as sleep,
        ):
            try:
                device.main()
            except SystemExit as caught:
                error = caught
        self.sleep = sleep
        return out.getvalue(), error

    def test_unauthorized_register_stops_with_a_token_error(self):
        server, seen = self._fake_artemis([401])
        _, error = self._run_main(server)
        self.assertIsNotNone(error)
        self.assertIn("HTTP 401 at register", str(error))
        self.assertIn("Check that this is the VPS ARTEMIS_DEVICE_TOKEN", str(error))
        self.assertEqual(len(seen), 1)

    def test_forbidden_register_stops_without_blaming_the_token(self):
        server, seen = self._fake_artemis([403])
        _, error = self._run_main(server)
        self.assertIsNotNone(error)
        self.assertIn("HTTP 403 at register", str(error))
        self.assertIn("does not establish that the device token is wrong", str(error))
        self.assertEqual(len(seen), 1)

    def test_server_error_reconnects_after_a_backoff_and_ctrl_c_disconnects(self):
        server, seen = self._fake_artemis([500])
        output, error = self._run_main(server, sleep_side_effect=KeyboardInterrupt)
        self.assertIsNone(error)
        self.assertEqual(len(seen), 1)
        self.sleep.assert_called_once_with(1)
        self.assertIn("reconnecting in 1s", output)
        self.assertIn("Disconnected.", output)

    def test_name_in_use_is_reported_and_retried_with_backoff(self):
        server, seen = self._fake_artemis([409])
        output, error = self._run_main(server)
        self.assertIsNone(error)
        self.assertEqual(len(seen), 1)
        self.sleep.assert_called_once_with(1)
        self.assertIn('"laptop" is already connected', output)
        self.assertIn("retrying in 1s", output)

    def test_expired_registration_registers_again(self):
        server, seen = self._fake_artemis([410, 500])
        output, error = self._run_main(server, sleep_side_effect=[None, KeyboardInterrupt])
        self.assertIsNone(error)
        self.assertEqual(len(seen), 2)
        self.assertIn("Session expired (HTTP 410 at register)", output)
        self.assertEqual(self.sleep.call_args_list[0].args, (1,))

    def test_token_tail_is_only_printed_with_verbose_auth(self):
        server, _ = self._fake_artemis([500])
        routine, _ = self._run_main(server)
        self.assertNotIn('ends with "', routine)
        self.assertIn("Token source:", routine)
        server, _ = self._fake_artemis([500])
        verbose, _ = self._run_main(server, "--verbose-auth")
        self.assertIn('ends with "alue"', verbose)
        self.assertNotIn(self.TOKEN, verbose)

    def test_connected_then_close_does_not_reset_the_reconnect_delay(self):
        """A gateway that accepts the stream and drops it must not be retried every second."""

        class Gateway(BaseHTTPRequestHandler):
            def do_POST(self):
                self.handle_any()

            def do_GET(self):
                self.handle_any()

            def handle_any(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.path.endswith("/events"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b"event: connected\ndata: {}\n\n")
                    self.wfile.flush()
                    return
                body = json.dumps({"session": "s1"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return None

        server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        output, error = self._run_main(
            server, sleep_side_effect=[None, None, None, None, KeyboardInterrupt]
        )
        self.assertIsNone(error)
        delays = [call.args[0] for call in self.sleep.call_args_list]
        self.assertEqual(delays[:4], [1, 2, 4, 8])
        self.assertGreaterEqual(output.count("Connected:"), 2)

    def test_stream_that_stays_up_resets_the_reconnect_delay(self):
        """After a long-lived stream, the next failure starts again from the 1 second delay."""
        streams = []

        class Gateway(BaseHTTPRequestHandler):
            def do_POST(self):
                self.handle_any()

            def do_GET(self):
                self.handle_any()

            def handle_any(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.path.endswith("/events"):
                    streams.append(self.path)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b"event: connected\ndata: {}\n\n")
                    self.wfile.flush()
                    return
                body = json.dumps({"session": "s1"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return None

        server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        # With a zero threshold, any stream that connected counts as stable, so it resets.
        with patch.object(device, "STABLE_STREAM_SECONDS", 0):
            _, error = self._run_main(
                server, sleep_side_effect=[None, None, None, None, KeyboardInterrupt]
            )
        self.assertIsNone(error)
        self.assertGreaterEqual(len(streams), 4)
        delays = [call.args[0] for call in self.sleep.call_args_list]
        self.assertEqual(delays[:4], [1, 1, 1, 1])


class ScopeAndEntryPointTests(unittest.TestCase):
    def test_filesystem_rejects_relative_paths_and_enforces_size_limits(self):
        from types import SimpleNamespace

        from artemis_device.scopes.filesystem import MAX_FILE_BYTES, register

        with tempfile.TemporaryDirectory() as directory:
            _, handlers = register(SimpleNamespace(active_folder=directory))
            with self.assertRaisesRegex(ValueError, "absolute"):
                handlers["filesystem_read"]({"path": "relative.txt"})
            with self.assertRaisesRegex(ValueError, "absolute"):
                handlers["filesystem_write"]({"path": "relative.txt", "content": "x"})
            large = Path(directory) / "large.txt"
            large.write_bytes(b"a" * (MAX_FILE_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "1 MB read limit"):
                handlers["filesystem_read"]({"path": str(large)})
            with self.assertRaisesRegex(ValueError, "1 MB write limit"):
                handlers["filesystem_write"](
                    {"path": str(large), "content": "a" * (MAX_FILE_BYTES + 1)}
                )

    def test_filesystem_read_reports_non_utf8_files_clearly(self):
        from types import SimpleNamespace

        from artemis_device.scopes.filesystem import register

        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "binary.dat"
            binary.write_bytes(b"\xff\xfe\x00bad")
            _, handlers = register(SimpleNamespace(active_folder=directory))
            with self.assertRaisesRegex(ValueError, "Only UTF-8 text files"):
                handlers["filesystem_read"]({"path": str(binary)})

    def test_list_directory_lists_sorted_entries_and_caps_iteration(self):
        from types import SimpleNamespace

        from artemis_device.scopes import filesystem

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "b.txt").write_text("bb", encoding="utf-8")
            Path(directory, "A.txt").write_text("a", encoding="utf-8")
            Path(directory, "sub").mkdir()
            _, handlers = filesystem.register(SimpleNamespace(active_folder=directory))
            listing = json.loads(
                handlers["filesystem_list"]({"path": directory})["content"][0]["text"]
            )
            self.assertEqual(
                [entry["name"] for entry in listing["entries"]], ["sub", "A.txt", "b.txt"]
            )
            self.assertEqual(listing["entries"][1]["size"], 1)
            self.assertFalse(listing["truncated"])
            with patch.object(filesystem, "MAX_LIST_ENTRIES", 2):
                capped = json.loads(
                    handlers["filesystem_list"]({"path": directory})["content"][0]["text"]
                )
            self.assertEqual(len(capped["entries"]), 2)
            self.assertTrue(capped["truncated"])

    def test_screenshot_removes_its_temp_file_when_capture_fails(self):
        from types import SimpleNamespace

        from artemis_device.scopes import screenshot

        created = []
        real_mkstemp = tempfile.mkstemp

        def recording_mkstemp(*args, **kwargs):
            fd, name = real_mkstemp(*args, **kwargs)
            created.append(name)
            return fd, name

        _, handlers = screenshot.register(SimpleNamespace(active_folder="."))
        with (
            patch.object(screenshot.tempfile, "mkstemp", side_effect=recording_mkstemp),
            patch.object(screenshot.shutil, "which", return_value=None),
            self.assertRaises(RuntimeError),
        ):
            handlers["screenshot_capture"]({})
        self.assertEqual(len(created), 1)
        self.assertFalse(Path(created[0]).exists())

    def test_scope_menu_requires_an_interactive_terminal(self):
        from artemis_device.menu import select_scopes

        with (
            patch("artemis_device.menu.sys.stdin", io.StringIO("")),
            self.assertRaisesRegex(RuntimeError, "--scopes"),
        ):
            select_scopes()

    def test_entry_point_rejects_conflicting_options_before_connecting(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = ["artemis-device", "laptop", "--scopes", "browser", "--mcp-command", "python"]
            with (
                patch.object(sys, "argv", argv),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as caught,
            ):
                device.run()
            self.assertEqual(caught.exception.code, 2)
            argv = [
                "artemis-device",
                "laptop",
                "--scopes",
                "browser",
                "--active-folder",
                directory + "-missing",
            ]
            with (
                patch.object(sys, "argv", argv),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as caught,
            ):
                device.parse_args()
            self.assertEqual(caught.exception.code, 2)

    def test_parse_args_accepts_an_explicit_argv(self):
        args = device.parse_args(
            ["laptop", "--scopes", "browser", "--server", "https://example.test"]
        )
        self.assertEqual(args.name, "laptop")
        self.assertEqual(args.scopes, ["browser"])
        self.assertEqual(args.server, "https://example.test")

    def test_default_server_follows_ip_address_like_voice_agent(self):
        # No root .env here: the developer's real one must not decide this test.
        no_env = Path(tempfile.gettempdir()) / "artemis-no-such-root"
        with (
            patch.object(device, "REPO_ROOT", no_env),
            patch.dict(os.environ, {"IP_ADDRESS": "10.1.2.3"}),
        ):
            os.environ.pop("ARTEMIS_URL", None)
            self.assertEqual(device.default_server(), "http://10.1.2.3:3000")
            os.environ["ARTEMIS_URL"] = "https://artemis.example.test"
            self.assertEqual(device.default_server(), "https://artemis.example.test")

    def test_dotenv_value_reads_one_unquoted_value(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text('export IP_ADDRESS="192.0.2.7"  # lan\nOTHER=1\n', encoding="utf-8")
            self.assertEqual(device.dotenv_value(path, "IP_ADDRESS"), "192.0.2.7")
            self.assertIsNone(device.dotenv_value(path, "MISSING"))
            self.assertIsNone(device.dotenv_value(Path(directory) / "absent.env", "IP_ADDRESS"))

    def test_malformed_requests_are_rejected_and_cannot_stop_execution(self):
        session = device.DeviceSession(
            name="laptop",
            server="http://127.0.0.1",
            token="test-token-value",
            token_source="test",
            token_hint=None,
            scope_tools=[],
            scope_handlers={},
            mcp_command=None,
        )
        self.assertFalse(device.is_request("not an object"))
        self.assertFalse(device.is_request({"method": "tools/call"}))
        self.assertTrue(device.is_request({"id": 1, "method": "tools/call"}))
        result = session.execute("not an object", "session")
        self.assertTrue(result["isError"])

    def test_tool_calls_are_audited_on_stderr(self):
        from types import SimpleNamespace

        from artemis_device.scopes.filesystem import register

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "note.txt"
            target.write_text("hello", encoding="utf-8")
            _, handlers = register(SimpleNamespace(active_folder=directory))
            session = device.DeviceSession(
                name="laptop",
                server="http://127.0.0.1",
                token="test-token-value",
                token_source="test",
                token_hint=None,
                scope_tools=[],
                scope_handlers=handlers,
                mcp_command=None,
            )
            errors = io.StringIO()
            with redirect_stderr(errors):
                result = session.execute(
                    {
                        "id": 7,
                        "method": "tools/call",
                        "params": {"name": "filesystem_read", "arguments": {"path": str(target)}},
                    },
                    "session",
                )
            self.assertNotIn("isError", result)
            self.assertIn("[audit] filesystem_read path=", errors.getvalue())
            self.assertNotIn("hello", errors.getvalue())


class RedirectAndPipeTests(unittest.TestCase):
    """Redirects are refused, so the bearer token and uploads stay with the gateway; background
    children cannot hold the terminal readers forever."""

    def _serve(self, handler_class):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_class)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def _redirect_pair(self, status):
        """A gateway that answers every request with a redirect to a second local server."""
        received = []

        class Target(BaseHTTPRequestHandler):
            def _record(self):
                length = int(self.headers.get("Content-Length") or 0)
                received.append((self.headers.get("Authorization"), self.rfile.read(length)))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = do_POST = _record

            def log_message(self, *_args):
                return None

        target = self._serve(Target)
        location = f"http://127.0.0.1:{target.server_address[1]}/elsewhere"

        class Gateway(BaseHTTPRequestHandler):
            def _redirect(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                self.send_response(status)
                self.send_header("Location", location)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST = _redirect

            def log_message(self, *_args):
                return None

        return self._serve(Gateway), received

    def _session(self, server):
        return device.DeviceSession(
            name="laptop",
            server=f"http://127.0.0.1:{server.server_address[1]}",
            token="test-token-value",
            token_source="test",
            token_hint=None,
            scope_tools=[],
            scope_handlers={},
            mcp_command=None,
        )

    def test_redirect_is_refused_and_the_token_is_not_sent_to_the_target(self):
        gateway, received = self._redirect_pair(302)
        session = self._session(gateway)
        with self.assertRaises(device.urllib.error.HTTPError) as raised:
            session.open_request("register", {"name": "laptop", "tools": []})
        self.assertEqual(raised.exception.code, 302)
        self.assertEqual(received, [])

    def test_upload_redirect_is_refused_and_the_token_and_body_are_not_resent(self):
        # urllib turns a 302 POST into a GET that keeps Authorization; a 307 POST is refused by
        # the stdlib already. Both must end at the gateway.
        for status in (302, 307):
            with self.subTest(status=status):
                gateway, received = self._redirect_pair(status)
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "data.bin"
                    path.write_bytes(b"secret-file-body")
                    with self.assertRaises(device.urllib.error.HTTPError) as raised:
                        device.upload_device_file(
                            f"http://127.0.0.1:{gateway.server_address[1]}",
                            "test-token-value",
                            "laptop",
                            "session",
                            "call-id",
                            path,
                        )
                self.assertEqual(raised.exception.code, status)
                self.assertEqual(received, [])

    # Known gap (R4-NA-007): closing a pipe from another thread does not wake a reader blocked in
    # read1 on Windows, and close() itself stalls. The readers end only when the background child
    # exits. Remove this decorator once the readers are released some other way.
    @unittest.expectedFailure
    def test_background_child_does_not_hold_the_reader_threads_forever(self):
        from artemis_device.scopes.terminal import register

        # The grandchild inherits stdout and outlives the command. Its pid is printed first, so
        # the test can stop it afterwards.
        code = (
            "import subprocess,sys\n"
            "p = subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],"
            "close_fds=False)\n"
            "print(p.pid, flush=True)\n"
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            _, handlers = register(SimpleNamespace(active_folder=directory))
            threads_before = threading.active_count()
            result = handlers["terminal_run"](
                {"command": sys.executable, "arguments": ["-c", code]}
            )
            text = result["content"][0]["text"]
            self.addCleanup(self._stop_pid, int(text.split("stdout:\n", 1)[1].split()[0]))
            self.assertIn("output incomplete", text)
            # Readers and the closer thread must finish within the bound, not stay blocked for
            # as long as the background child runs.
            deadline = time.monotonic() + 15
            while threading.active_count() > threads_before and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertLessEqual(threading.active_count(), threads_before)

    @staticmethod
    def _stop_pid(pid):
        if os.name == "nt":
            import subprocess

            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            import signal

            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
