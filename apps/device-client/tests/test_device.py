import io
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artemis_device import cli as device
class DeviceTest(unittest.TestCase):
    def test_macos_media_actions_do_not_require_volume(self):
        from types import SimpleNamespace
        from scopes import media
        actions = ('play', 'pause', 'play_pause', 'info', 'volume_up', 'volume_down')
        with patch.object(media.sys, 'platform', 'darwin'), patch.object(media.shutil, 'which', return_value='osascript'):
            _, handlers = media.register(SimpleNamespace())
            for action in actions:
                with self.subTest(action=action), patch.object(media.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as run:
                    handlers['media_control']({'action': action})
                    self.assertEqual(run.call_args.args[0][0], 'osascript')
            with patch.object(media.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as run:
                handlers['media_control']({'action': 'volume', 'volume': 42.6})
                self.assertIn('43', run.call_args.args[0][-1])
    def test_terminal_shell_lines_spaces_quotes_and_pipes(self):
        from types import SimpleNamespace
        from scopes.terminal import register
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file with spaces.txt'
            path.write_text('quoted-path-content', encoding='utf-8')
            _, handlers = register(SimpleNamespace(active_folder=directory))
            commands = [
                "Write-Output 'été with spaces' | ForEach-Object { $_ }" if os.name == 'nt' else "printf 'été with spaces' | cat",
                "Get-Content 'file with spaces.txt'" if os.name == 'nt' else "cat 'file with spaces.txt'",
            ]
            for command, expected in zip(commands, ['été with spaces', 'quoted-path-content']):
                result = handlers['terminal_run']({'command': command, 'arguments': []})
                self.assertIn('exit_code: 0', result['content'][0]['text'])
                self.assertIn(expected, result['content'][0]['text'])
            result = handlers['terminal_run']({'command': sys.executable, 'arguments': ['-c', 'import sys; print(sys.argv[1])', 'literal & $value | argument']})
            self.assertIn('literal & $value | argument', result['content'][0]['text'])
    def test_terminal_can_run_and_read_outside_active_folder(self):
        from types import SimpleNamespace
        from scopes.terminal import register
        with tempfile.TemporaryDirectory() as directory:
            active = Path(directory) / 'active'
            outside = Path(directory) / 'other'
            active.mkdir()
            outside.mkdir()
            (outside / 'example.txt').write_text('outside-folder-access', encoding='utf-8')
            tools, handlers = register(SimpleNamespace(active_folder=str(active)))
            self.assertIn('system-wide', tools[0]['description'])
            result = handlers['terminal_run']({'command': sys.executable, 'arguments': ['-c', "from pathlib import Path; print(Path('example.txt').read_text())"], 'cwd': str(outside)})
            self.assertIn('exit_code: 0', result['content'][0]['text'])
            self.assertIn('outside-folder-access', result['content'][0]['text'])
            result = handlers['terminal_run']({'command': sys.executable, 'arguments': ['-c', 'from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text())', str(outside / 'example.txt')]})
            self.assertIn('outside-folder-access', result['content'][0]['text'])
    def test_device_upload_streams_exact_binary_bytes_over_http(self):
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        received = {}
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received['path'] = self.path
                received['auth'] = self.headers['Authorization']
                received['session'] = self.headers['X-Device-Session']
                received['body'] = self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'path': 'data/device-files/id/rib.pdf'}).encode())
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'rib.pdf'
                payload = bytes(range(256)) * 1000
                path.write_bytes(payload)
                result = device.upload_device_file(f'http://127.0.0.1:{server.server_port}', 'test-token', 'pc', 'session', 'call-id', path)
                self.assertEqual(received['body'], payload)
                self.assertEqual(received['auth'], 'Bearer test-token')
                self.assertEqual(received['session'], 'session')
                self.assertEqual(received['path'], '/api/devices/pc/files/call-id')
                self.assertEqual(result, {'path': 'data/device-files/id/rib.pdf'})
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
    def test_filesystem_export_returns_metadata_without_reading_binary_into_context(self):
        from types import SimpleNamespace
        from scopes.filesystem import register
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rib.pdf'
            payload = b'%PDF-1.7\n\x00\xff\x80binary'
            path.write_bytes(payload)
            tools, handlers = register(SimpleNamespace(active_folder=directory))
            self.assertIn('filesystem_export', [tool['name'] for tool in tools])
            metadata = {'path': 'data/device-files/id/rib.pdf', 'size': len(payload)}
            def upload(source):
                self.assertEqual(source.read_bytes(), payload)
                return metadata
            result = handlers['filesystem_export']({'path': str(path)}, upload)
            self.assertNotIn('binary', result['content'][0]['text'])
            self.assertIn(metadata['path'], result['content'][0]['text'])
            with self.assertRaises(ValueError): handlers['filesystem_export']({'path': 'relative.pdf'}, upload)
            with self.assertRaises(ValueError): handlers['filesystem_read']({'path': str(path)})
    def test_token_paste_normalization(self):
        for pasted in ['  demo-token\n', '"demo-token"', 'ARTEMIS_DEVICE_TOKEN=\'demo-token\'', '\x1b[200~demo-token\x1b[201~']:
            self.assertEqual(device.normalize_token(pasted), 'demo-token')
        for pasted in ['', 'demo token', 'demo\u200btoken']:
            with self.assertRaises(ValueError): device.normalize_token(pasted)
    def test_token_file_overrides_stale_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('OTHER_KEY=ignored\nARTEMIS_DEVICE_TOKEN="file-token" # device credential\n')
            with patch.dict(os.environ, {'ARTEMIS_DEVICE_TOKEN':'stale-token'}):
                self.assertEqual(device.load_device_token(str(path)), ('file-token', str(path.resolve())))
                self.assertEqual(device.load_device_token()[0], 'stale-token')
            with self.assertRaises(ValueError): device.load_device_token(str(path.parent / 'missing'))
    def test_persistent_connection_events(self):
        from artemis_device.transport import stream_events
        response = io.BytesIO(b'event: connected\ndata: {"name":"laptop"}\n\nevent: ping\ndata: {}\n\nevent: request\ndata: {"id":"1",\ndata: "method":"tools/call"}\n\n')
        self.assertEqual(list(stream_events(response)), [('connected', {'name':'laptop'}), ('ping', {}), ('request', {'id':'1','method':'tools/call'})])
    def test_firefox_uses_arguments_without_shell(self):
        from scopes.browser import open_url
        with patch('scopes.browser.subprocess.Popen') as popen:
            result = open_url({'url': 'https://example.com/?x=a&y=b'}, 'firefox')
            self.assertIn('Opened', result['content'][0]['text'])
            self.assertEqual(popen.call_args.args[0], ['firefox', '--new-tab', 'https://example.com/?x=a&y=b'])
            self.assertNotIn('shell', popen.call_args.kwargs)
    def test_rejects_unsafe_urls(self):
        from scopes.browser import open_url
        for url in ['file:///tmp/private', 'javascript:alert(1)', '--help', 'https://', 'https://example.com/\n']:
            with self.assertRaises(ValueError): open_url({'url': url}, 'firefox')
    def test_browser_owns_open_url_handler(self):
        from scopes.browser import open_url, register
        from types import SimpleNamespace
        tools, handlers = register(SimpleNamespace(firefox='firefox'))
        self.assertIn('open_url', handlers)
        with patch('scopes.browser.subprocess.Popen') as popen:
            self.assertIn('Opened', open_url({'url': 'https://example.com'}, 'firefox')['content'][0]['text'])
            self.assertEqual(popen.call_args.args[0], ['firefox', '--new-tab', 'https://example.com'])
    def test_stdio_mcp(self):
        script = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' in m:\n  result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]} if m['method']=='tools/list' else {'content':[{'type':'text','text':'ok'}]}\n  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)"
        server = device.StdioMcp([sys.executable, '-u', '-c', script])
        try:
            self.assertEqual(server.tools()[0]['name'], 'echo')
            self.assertEqual(server.rpc('tools/call', {'name': 'echo'})['content'][0]['text'], 'ok')
        finally: server.close()
    def test_stdio_mcp_preserves_unrelated_responses(self):
        from artemis_device.transport import StdioMcp
        script = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n if m['method']=='initialize': r={}\n elif m['method']=='tools/list':\n  print(json.dumps({'jsonrpc':'2.0','id':3,'result':{'content':[{'type':'text','text':'saved'}]}}),flush=True); r={'tools':[]}\n else: r={'content':[{'type':'text','text':'actual'}]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with StdioMcp([sys.executable, '-u', '-c', script]) as server:
            self.assertEqual(server.tools(), [])
            self.assertEqual(server.rpc('tools/call', {})['content'][0]['text'], 'saved')
    def test_stdio_mcp_timeout_is_explicit_and_closes_process(self):
        from artemis_device.transport import StdioMcp
        script = "import sys,json,time\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{}}),flush=True); time.sleep(30)"
        server = StdioMcp([sys.executable, '-u', '-c', script], timeout=2)
        server.timeout = 0.05
        with self.assertRaisesRegex(TimeoutError, 'tools/list request timed out'):
            server.rpc('tools/list', {})
        self.assertTrue(server._closed)
        self.assertIsNotNone(server.process.poll())
        self.assertFalse(server._reader_thread.is_alive())
    def test_stdio_mcp_close_unblocks_full_stdout_queue_and_joins_reader(self):
        script = "import sys,json\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{}}),flush=True); sys.stdin.readline(); [print(json.dumps({'jsonrpc':'2.0','method':'notifications/progress','params':{}}),flush=True) for _ in range(200)]"
        server = device.StdioMcp([sys.executable, '-u', '-c', script], timeout=2)
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
        server = device.StdioMcp([sys.executable, '-u', '-c', script], timeout=2)
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
        with device.StdioMcp([sys.executable, '-u', '-c', repeated]) as server:
            with self.assertRaisesRegex(RuntimeError, 'repeated pagination cursor'):
                server.tools()
            self.assertTrue(server._closed)
        oversized = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n r={} if m['method']=='initialize' else {'tools':[{} for _ in range(101)]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with device.StdioMcp([sys.executable, '-u', '-c', oversized]) as server:
            with self.assertRaisesRegex(RuntimeError, 'more than 100 tools'):
                server.tools()
        endless = "import sys,json\npages=0\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n if m['method']=='initialize': r={}\n else:\n  pages+=1; r={'tools':[],'nextCursor':str(pages)}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)"
        with device.StdioMcp([sys.executable, '-u', '-c', endless]) as server:
            with self.assertRaisesRegex(RuntimeError, 'exceeded 100 pages'):
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
                    yield b'event: ping\n'
                    self.yielded += 1
                    yield b'data: {}\n'
                    self.yielded += 1
                    yield b'\n'
            def close(self): self.closed.set()
        response = FloodResponse()
        events = interruptible_stream_events(response)
        self.assertEqual(next(events), ('ping', {}))
        deadline = time.monotonic() + 2
        while response.yielded < 100 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(response.yielded, 100)
        events.close()
        self.assertFalse(any(t.name == 'artemis-sse-reader' for t in threading.enumerate()))
    def test_stdio_mcp_initialization_failure_cleans_up_process(self):
        script = "import sys,json,time\nm=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':m['id'],'error':{'code':-1,'message':'no'}}),flush=True); time.sleep(30)"
        with self.assertRaises(RuntimeError): device.StdioMcp([sys.executable, '-u', '-c', script], timeout=1)
    def test_terminal_reports_truncated_output(self):
        from types import SimpleNamespace
        from scopes.terminal import register
        with tempfile.TemporaryDirectory() as directory:
            _, handlers = register(SimpleNamespace(active_folder=directory))
            command = [sys.executable, '-c', 'print("x" * 70000)']
            result = handlers['terminal_run']({'command': command[0], 'arguments': command[1:]})['content'][0]['text']
            self.assertIn('[stdout truncated at 64 KB]', result)
if __name__ == '__main__': unittest.main()
