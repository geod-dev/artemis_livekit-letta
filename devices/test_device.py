import importlib.util
import io
import sys
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('device', 'devices/artemis-device.py')
device = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device)
class DeviceTest(unittest.TestCase):
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
