#!/usr/bin/env python3
"""Outbound Artemis device bridge. Python 3.10+, no third-party dependencies."""
import argparse
import getpass
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

FIREFOX_TOOL = {
    'name': 'open_url',
    'description': 'Open an HTTP or HTTPS URL in Firefox on this device.',
    'inputSchema': {'type': 'object', 'properties': {'url': {'type': 'string'}}, 'required': ['url'], 'additionalProperties': False},
    'annotations': {'readOnlyHint': False},
}

def open_url(arguments, firefox=None):
    url = arguments.get('url')
    if not isinstance(url, str) or any(ord(c) < 32 for c in url):
        raise ValueError('A valid HTTP or HTTPS URL is required')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('Only HTTP and HTTPS URLs are allowed')
    executable = firefox or shutil.which('firefox')
    if not executable:
        candidates = [os.path.join(os.environ.get('PROGRAMFILES', ''), 'Mozilla Firefox', 'firefox.exe'),
                      os.path.join(os.environ.get('PROGRAMFILES(X86)', ''), 'Mozilla Firefox', 'firefox.exe'),
                      '/Applications/Firefox.app/Contents/MacOS/firefox']
        executable = next((p for p in candidates if os.path.isfile(p)), None)
    if not executable:
        raise RuntimeError('Firefox not found. Supply --firefox with its executable path.')
    subprocess.Popen([executable, '--new-tab', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {'content': [{'type': 'text', 'text': 'Opened in Firefox: ' + url}]}

class StdioMcp:
    """Relay tools from any local MCP stdio server using JSON-RPC."""
    def __init__(self, command):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
        self.messages = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self.read, daemon=True).start()
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'artemis-device', 'version': '1'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
    def read(self):
        for line in self.process.stdout:
            try: self.messages.put(json.loads(line))
            except ValueError: pass
        self.messages.put(None)
    def send(self, message):
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()
    def rpc(self, method, params):
        self.next_id += 1
        ident = self.next_id
        self.send({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
        deadline = time.monotonic() + 50
        while True:
            message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if message is None: raise RuntimeError('Local MCP server exited')
            if message.get('id') == ident and 'method' not in message:
                if 'error' in message: raise RuntimeError(str(message['error']))
                return message['result']
            if 'method' in message and 'id' in message:
                self.send({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Client capabilities not supported'}})
            if time.monotonic() >= deadline: raise TimeoutError('Local MCP request timed out')
    def tools(self):
        tools, params = [], {}
        while True:
            page = self.rpc('tools/list', params)
            tools.extend(page['tools'])
            if not page.get('nextCursor'): return tools
            params = {'cursor': page['nextCursor']}
    def close(self):
        self.process.terminate()
        try: self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill(); self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name', help='Unique device name: letters, numbers, underscores, hyphens')
    parser.add_argument('--server', default=os.environ.get('ARTEMIS_URL', 'https://185.252.233.123'))
    parser.add_argument('--firefox', help='Firefox executable path')
    parser.add_argument('--mcp-command', nargs=argparse.REMAINDER, help='Relay a local MCP stdio server instead of the built-in Firefox tool; put this option last')
    args = parser.parse_args()
    if urllib.parse.urlsplit(args.server).scheme != 'https' and urllib.parse.urlsplit(args.server).hostname not in ('localhost', '127.0.0.1'):
        parser.error('Use HTTPS for remote servers')
    token = os.environ.get('ARTEMIS_DEVICE_TOKEN') or getpass.getpass('Device token: ')
    if not token: parser.error('A device token is required')
    server = args.server.rstrip('/')
    print(f'Connecting to Artemis at {server} as "{args.name}"...', flush=True)
    if args.mcp_command:
        print('Starting the local MCP server and loading its tools...', flush=True)
    local = StdioMcp(args.mcp_command) if args.mcp_command else None
    def request(path, body=None, session=None):
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if session: headers['X-Device-Session'] = session
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(server + '/api/devices/' + path, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=35) as response:
            return json.load(response)
    session = None
    delay = 1
    try:
        while True:
            try:
                if session is None:
                    tools = local.tools() if local else [FIREFOX_TOOL]
                    print(f'Registering device with Artemis ({len(tools)} tool(s))...', flush=True)
                    session = request('register', {'name': args.name, 'tools': tools})['session']
                    print(f'Connected: {args.name} ({len(tools)} tool(s)). Leave this window open.', flush=True)
                messages = request(urllib.parse.quote(args.name, safe='') + '/poll', session=session)['requests']
                delay = 1
                for message in messages:
                    try:
                        if message.get('method') != 'tools/call': raise ValueError('Unsupported MCP method')
                        params = message['params']
                        if local: result = local.rpc('tools/call', params)
                        elif params['name'] == 'open_url': result = open_url(params.get('arguments', {}), args.firefox)
                        else: raise ValueError('Unknown tool')
                    except Exception as error:
                        result = {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
                    # Never replay an action after a failed response upload.
                    request(urllib.parse.quote(args.name, safe='') + '/results', {'jsonrpc': '2.0', 'id': message['id'], 'result': result}, session)
            except urllib.error.HTTPError as error:
                if error.code in (401, 403): raise SystemExit('Device authentication rejected; check ARTEMIS_DEVICE_TOKEN')
                session = None
                print(f'Artemis returned HTTP {error.code} ({error.reason}); reconnecting in {delay}s.', flush=True)
                time.sleep(delay); delay = min(delay * 2, 30)
            except (OSError, ValueError, KeyError) as error:
                session = None
                print(f'Connection failed ({error}); retrying in {delay}s.', flush=True)
                time.sleep(delay); delay = min(delay * 2, 30)
    except KeyboardInterrupt:
        pass
    finally:
        if local: local.close()

if __name__ == '__main__': main()
