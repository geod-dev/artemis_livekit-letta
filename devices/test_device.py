import importlib.util
import io
import os
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('device', 'devices/artemis-device.py')
device = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device)
class DeviceTest(unittest.TestCase):
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
        response = io.BytesIO(b'event: connected\ndata: {"name":"laptop"}\n\nevent: ping\ndata: {}\n\nevent: request\ndata: {"id":"1",\ndata: "method":"tools/call"}\n\n')
        self.assertEqual(list(device.stream_events(response)), [('connected', {'name':'laptop'}), ('ping', {}), ('request', {'id':'1','method':'tools/call'})])
    def test_firefox_uses_arguments_without_shell(self):
        with patch.object(device.subprocess, 'Popen') as popen:
            result = device.open_url({'url': 'https://example.com/?x=a&y=b'}, 'firefox')
            self.assertIn('Opened', result['content'][0]['text'])
            self.assertEqual(popen.call_args.args[0], ['firefox', '--new-tab', 'https://example.com/?x=a&y=b'])
            self.assertNotIn('shell', popen.call_args.kwargs)
    def test_rejects_unsafe_urls(self):
        for url in ['file:///tmp/private', 'javascript:alert(1)', '--help', 'https://', 'https://example.com/\n']:
            with self.assertRaises(ValueError): device.open_url({'url': url}, 'firefox')
    def test_stdio_mcp(self):
        script = "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' in m:\n  result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]} if m['method']=='tools/list' else {'content':[{'type':'text','text':'ok'}]}\n  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)"
        server = device.StdioMcp([sys.executable, '-u', '-c', script])
        try:
            self.assertEqual(server.tools()[0]['name'], 'echo')
            self.assertEqual(server.rpc('tools/call', {'name': 'echo'})['content'][0]['text'], 'ok')
        finally: server.close()
if __name__ == '__main__': unittest.main()
