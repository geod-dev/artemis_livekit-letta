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

AVAILABLE_SCOPES = ('browser', 'media', 'filesystem', 'terminal', 'screenshot')


def select_scopes():
    """Show a small keyboard-driven multi-select menu in an interactive terminal."""
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError('Choose scopes with --scopes when running without an interactive terminal.')

    selected = {'browser'}
    cursor = 0
    labels = [
        'Browser — open HTTP(S) URLs',
        'Media — control playback and volume',
        'Filesystem — list, read, and write files',
        'Terminal — run any installed command',
        'Screenshot — capture the desktop',
    ]
    lines = []

    def render(first=False):
        nonlocal lines
        current = [
            'Select Device scopes (↑/↓ move, Space toggles, Enter confirms, q cancels)',
            '',
        ]
        current.extend(f"{'❯' if index == cursor else ' '} [{'x' if scope in selected else ' '}] {label}"
                       for index, (scope, label) in enumerate(zip(AVAILABLE_SCOPES, labels)))
        current.extend(['', 'Browser is selected by default. Terminal can run any installed command.'])
        if not first:
            sys.stdout.write(f'\x1b[{len(lines)}A')
        for line in current:
            sys.stdout.write('\r\x1b[2K' + line + '\n')
        sys.stdout.flush()
        lines = current

    def read_key():
        if os.name == 'nt':
            import msvcrt
            key = msvcrt.getwch()
            if key in ('\x00', '\xe0'):
                return {'H': 'up', 'P': 'down'}.get(msvcrt.getwch(), '')
            if key == '\x03': raise KeyboardInterrupt
            if key == '\r': return 'enter'
            if key == ' ': return 'space'
            return key.casefold()

        import termios
        import tty
        fd = sys.stdin.fileno()
        previous = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            key = sys.stdin.read(1)
            if key == '\x03': raise KeyboardInterrupt
            if key == '\x1b':
                sequence = sys.stdin.read(2)
                return {'\x1b[A': 'up', '\x1b[B': 'down'}.get(key + sequence, '')
            if key in ('\r', '\n'): return 'enter'
            if key == ' ': return 'space'
            return key.casefold()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, previous)

    sys.stdout.write('\x1b[?25l')
    try:
        render(first=True)
        while True:
            key = read_key()
            if key == 'up': cursor = (cursor - 1) % len(AVAILABLE_SCOPES)
            elif key == 'down': cursor = (cursor + 1) % len(AVAILABLE_SCOPES)
            elif key == 'space':
                scope = AVAILABLE_SCOPES[cursor]
                if scope in selected: selected.remove(scope)
                else: selected.add(scope)
            elif key == 'enter':
                return [scope for scope in AVAILABLE_SCOPES if scope in selected]
            elif key == 'q':
                raise SystemExit(0)
            render()
    finally:
        sys.stdout.write('\x1b[?25h\x1b[0m\n')
        sys.stdout.flush()


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


def interruptible_stream_events(response):
    """Keep socket reads off the main thread so Ctrl+C is handled promptly."""
    events = queue.Queue()

    def read_events():
        try:
            for event in stream_events(response):
                events.put(event)
        except Exception as error:
            events.put(error)
        finally:
            events.put(None)

    threading.Thread(target=read_events, daemon=True).start()
    while True:
        try: item = events.get(timeout=0.25)
        except queue.Empty: continue
        if item is None: return
        if isinstance(item, Exception): raise item
        yield item


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
    parser.add_argument('--server', default=os.environ.get('ARTEMIS_URL', 'https://185.252.233.123'))
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
    try: scope_tools, scope_handlers = build_scopes(args)
    except (OSError, RuntimeError, ValueError) as error: parser.error(str(error))
    try: token, token_source = load_device_token(args.env_file)
    except (ValueError, OSError) as error: parser.error(str(error))
    fingerprint = hashlib.sha256(token.encode()).hexdigest()[:12]
    print(f'Token source: {token_source} ({len(token)} characters, fingerprint {fingerprint}).', flush=True)
    server = args.server.rstrip('/')
    print(f'Connecting to Artemis at {server} as "{args.name}"...', flush=True)
    local = None
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
    def upload_file(path, call_id):
        return upload_device_file(server, token, args.name, session, call_id, path)
    def execute(message):
        try:
            if message.get('method') != 'tools/call': raise ValueError('Unsupported MCP method')
            params = message['params']
            if local: return local.rpc('tools/call', params)
            handler = scope_handlers.get(params['name'])
            if handler is None: raise ValueError('Unknown tool')
            if params['name'] == 'filesystem_export':
                return handler(params.get('arguments', {}), upload=lambda path: upload_file(path, message['id']))
            return handler(params.get('arguments', {}))
        except Exception as error:
            return {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
    device_path = urllib.parse.quote(args.name, safe='')
    session = None
    delay = 1
    try:
        if args.mcp_command:
            print('Starting the local MCP server and loading its tools...', flush=True)
            local = StdioMcp(args.mcp_command)
        while True:
            try:
                tools = local.tools() if local else scope_tools
                print(f'Registering device with Artemis ({len(tools)} tool(s))...', flush=True)
                session = request('register', {'name': args.name, 'tools': tools})['session']
                with open_request(device_path + '/events', session=session) as response:
                    for event, message in interruptible_stream_events(response):
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
                    try: request(device_path + '/disconnect', {}, session, timeout=3)
                    except (OSError, ValueError): pass
                    session = None
            time.sleep(delay); delay = min(delay * 2, 30)
    except KeyboardInterrupt:
        print('Disconnected.', flush=True)
    finally:
        if local: local.close()

if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: print('Disconnected.', flush=True)
