#!/usr/bin/env python3
"""Outbound Artemis device bridge. Python 3.10+, no third-party dependencies."""
import argparse
import getpass
import hashlib
import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scopes import build_scopes
from scopes.browser import open_url

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


def stream_events(response):
    """Read the persistent device event connection without third-party packages."""
    event, data = 'message', []
    for raw in response:
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if data: yield event, json.loads('\n'.join(data))
            event, data = 'message', []
        elif line.startswith('event:'):
            event = line[6:].lstrip()
        elif line.startswith('data:'):
            data.append(line[5:].lstrip())


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name', help='Unique device name: letters, numbers, underscores, hyphens')
    parser.add_argument('--server', default=os.environ.get('ARTEMIS_URL', 'https://185.252.233.123'))
    parser.add_argument('--firefox', help='Firefox executable path')
    parser.add_argument('--scopes', nargs='+', choices=('browser', 'media', 'filesystem', 'terminal', 'screenshot'), default=[], metavar='SCOPE', help='Scopes to expose (browser, media, filesystem, terminal, screenshot)')
    parser.add_argument('--filesystem-root', action='append', default=[], metavar='PATH', help='Filesystem root available to the filesystem scope; repeat to add roots (defaults to the current directory)')
    parser.add_argument('--terminal-command', action='append', default=[], metavar='NAME', help='Executable name allowed by the terminal scope; repeat to add commands. Commands run without a shell.')
    parser.add_argument('--env-file', help='Read ARTEMIS_DEVICE_TOKEN from this file instead of the environment or the project .env')
    parser.add_argument('--mcp-command', nargs=argparse.REMAINDER, help='Relay a local MCP stdio server instead of built-in scopes; put this option last')
    args = parser.parse_args()
    if urllib.parse.urlsplit(args.server).scheme != 'https' and urllib.parse.urlsplit(args.server).hostname not in ('localhost', '127.0.0.1'):
        parser.error('Use HTTPS for remote servers')
    if args.mcp_command and args.scopes:
        parser.error('--mcp-command cannot be combined with built-in --scopes')
    if 'terminal' in args.scopes and not args.terminal_command:
        parser.error('The terminal scope requires at least one --terminal-command allowlist entry')
    try: scope_tools, scope_handlers = build_scopes(args)
    except (OSError, RuntimeError, ValueError) as error: parser.error(str(error))
    try: token, token_source = load_device_token(args.env_file)
    except (ValueError, OSError) as error: parser.error(str(error))
    fingerprint = hashlib.sha256(token.encode()).hexdigest()[:12]
    print(f'Token source: {token_source} ({len(token)} characters, fingerprint {fingerprint}).', flush=True)
    server = args.server.rstrip('/')
    print(f'Connecting to Artemis at {server} as "{args.name}"...', flush=True)
    if args.mcp_command:
        print('Starting the local MCP server and loading its tools...', flush=True)
    local = StdioMcp(args.mcp_command) if args.mcp_command else None
    def open_request(path, body=None, session=None):
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if session: headers['X-Device-Session'] = session
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(server + '/api/devices/' + path, data=data, headers=headers)
        try: return urllib.request.urlopen(req, timeout=35)
        except urllib.error.HTTPError as error:
            error.artemis_endpoint = path
            raise
        except OSError as error:
            raise ConnectionError(f'{path}: {error}') from error
    def request(path, body=None, session=None):
        with open_request(path, body, session) as response:
            return json.load(response)
    def execute(message):
        try:
            if message.get('method') != 'tools/call': raise ValueError('Unsupported MCP method')
            params = message['params']
            if local: return local.rpc('tools/call', params)
            handler = scope_handlers.get(params['name'])
            if handler is None: raise ValueError('Unknown tool')
            return handler(params.get('arguments', {}))
        except Exception as error:
            return {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
    device_path = urllib.parse.quote(args.name, safe='')
    session = None
    delay = 1
    try:
        while True:
            try:
                tools = local.tools() if local else scope_tools
                print(f'Registering device with Artemis ({len(tools)} tool(s))...', flush=True)
                session = request('register', {'name': args.name, 'tools': tools})['session']
                with open_request(device_path + '/events', session=session) as response:
                    for event, message in stream_events(response):
                        if event == 'connected':
                            print(f'Connected: {args.name} ({len(tools)} tool(s)). Leave this window open.', flush=True)
                            delay = 1
                        elif event == 'ping':
                            request(device_path + '/heartbeat', {}, session)
                        elif event == 'request':
                            result = execute(message)
                            # Never replay an action after a failed response upload.
                            request(device_path + '/results', {'jsonrpc': '2.0', 'id': message['id'], 'result': result}, session)
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
            except (OSError, ValueError, KeyError) as error:
                print(f'Connection failed ({error}); retrying in {delay}s.', flush=True)
            finally:
                if session:
                    try: request(device_path + '/disconnect', {}, session)
                    except (OSError, ValueError): pass
                    session = None
            time.sleep(delay); delay = min(delay * 2, 30)
    except KeyboardInterrupt:
        print('Disconnected.', flush=True)
    finally:
        if local: local.close()

if __name__ == '__main__': main()
