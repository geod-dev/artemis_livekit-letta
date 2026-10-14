"""Local MCP stdio transport and SSE event helpers."""
import json
import queue
import subprocess
import threading
import time

MAX_MCP_MESSAGES = 128
MAX_TOOLS = 100
MAX_TOOL_PAGES = 100

class StdioMcp:
    """Relay tools from any local MCP stdio server using JSON-RPC."""
    def __init__(self, command, timeout=30):
        self.command = list(command)
        self.timeout = timeout
        self._rpc_lock = threading.Lock()
        self._closed = False
        self._responses = {}
        self._response_lock = threading.Lock()
        self.process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
        self.messages = queue.Queue(maxsize=MAX_MCP_MESSAGES)
        self.next_id = 0
        self._reader_stop = threading.Event()
        self._reader_done = threading.Event()
        self._reader_started = False
        self._reader_error = None
        self._reader_thread = threading.Thread(target=self.read, daemon=True, name='artemis-mcp-reader')
        try:
            self._reader_thread.start()
            self._reader_started = True
            self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'artemis-device', 'version': '1'}})
            self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        except BaseException:
            self.close()
            raise
    def read(self):
        try:
            for line in self.process.stdout:
                if self._reader_stop.is_set(): return
                try: message = json.loads(line)
                except ValueError: continue
                while not self._reader_stop.is_set():
                    try:
                        self.messages.put(message, timeout=0.1)
                        break
                    except queue.Full:
                        continue
        except (OSError, ValueError) as error:
            if not self._reader_stop.is_set(): self._reader_error = error
        finally:
            self._reader_done.set()
    def send(self, message):
        if self._closed or self.process.poll() is not None:
            raise RuntimeError('Local MCP server is not running')
        try:
            self.process.stdin.write(json.dumps(message) + '\n')
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise RuntimeError('Local MCP server exited') from error
    def rpc(self, method, params):
        with self._rpc_lock:
            self.next_id += 1
            ident = self.next_id
            self.send({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
            deadline = time.monotonic() + self.timeout
            while True:
                with self._response_lock:
                    message = self._responses.pop(ident, None)
                if message is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self.close()
                        raise TimeoutError(f'Local MCP {method} request timed out after {self.timeout}s')
                    try: message = self.messages.get(timeout=min(remaining, 0.1))
                    except queue.Empty:
                        if self._reader_done.is_set() or self.process.poll() is not None:
                            message = 'Local MCP server exited'
                            if self._reader_error: message += f': {self._reader_error}'
                            raise RuntimeError(message) from self._reader_error
                        if time.monotonic() >= deadline:
                            self.close()
                            raise TimeoutError(f'Local MCP {method} request timed out after {self.timeout}s')
                        continue
                if 'method' in message and 'id' in message:
                    self.send({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Client capabilities not supported'}})
                elif message.get('id') == ident:
                    if 'error' in message: raise RuntimeError(str(message['error']))
                    return message['result']
                elif 'id' in message:
                    # Keep unrelated replies for their owning request instead of dropping them.
                    with self._response_lock:
                        if len(self._responses) >= 128:
                            self.close()
                            raise RuntimeError('Too many unmatched local MCP responses')
                        self._responses[message['id']] = message
    def tools(self):
        try:
            return self._list_tools()
        except BaseException:
            self.close()
            raise
    def _list_tools(self):
        tools, params = [], {}
        cursors = set()
        while True:
            if len(cursors) >= MAX_TOOL_PAGES:
                raise RuntimeError(f'Local MCP tools/list exceeded {MAX_TOOL_PAGES} pages')
            page = self.rpc('tools/list', params)
            if not isinstance(page, dict):
                raise RuntimeError('Local MCP tools/list returned an invalid tools page')
            page_tools = page.get('tools')
            if not isinstance(page_tools, list):
                raise RuntimeError('Local MCP tools/list returned an invalid tools page')
            if len(tools) + len(page_tools) > MAX_TOOLS:
                raise RuntimeError(f'Local MCP server returned more than {MAX_TOOLS} tools')
            tools.extend(page_tools)
            cursor = page.get('nextCursor')
            if not cursor: return tools
            if not isinstance(cursor, str):
                raise RuntimeError('Local MCP tools/list returned an invalid pagination cursor')
            if cursor in cursors:
                raise RuntimeError(f'Local MCP tools/list repeated pagination cursor {cursor!r}')
            cursors.add(cursor)
            params = {'cursor': cursor}
    def close(self):
        first_close = not self._closed
        self._closed = True
        self._reader_stop.set()
        if first_close and self.process.stdin and not self.process.stdin.closed:
            try: self.process.stdin.close()
            except (OSError, ValueError): pass
        if self.process.poll() is None:
            try: self.process.terminate()
            except OSError: pass
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try: self.process.kill()
                except OSError: pass
                self.process.wait(timeout=2)
        if self._reader_started: self._reader_thread.join(timeout=2)
        if self._reader_thread.is_alive() and self.process.stdout and not self.process.stdout.closed:
            try: self.process.stdout.close()
            except (OSError, ValueError): pass
            self._reader_thread.join(timeout=2)
        if self._reader_thread.is_alive():
            raise RuntimeError('Local MCP stdout reader did not stop after process shutdown')
        if self.process.stdout and not self.process.stdout.closed:
            try: self.process.stdout.close()
            except (OSError, ValueError): pass
    def __enter__(self): return self
    def __exit__(self, *_): self.close()


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
    events = queue.Queue(maxsize=32)
    stop = threading.Event()
    done = threading.Event()

    def deliver(item):
        while not stop.is_set():
            try:
                events.put(item, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    def read_events():
        try:
            for event in stream_events(response):
                if not deliver(event): return
        except Exception as error:
            deliver(error)
        finally:
            done.set()

    reader = threading.Thread(target=read_events, daemon=True, name='artemis-sse-reader')
    reader.start()
    try:
        while True:
            if done.is_set() and events.empty(): return
            try: item = events.get(timeout=0.1)
            except queue.Empty: continue
            if isinstance(item, Exception): raise item
            yield item
    finally:
        stop.set()
        try: response.close()
        except Exception: pass
        reader.join(timeout=3)
        if reader.is_alive():
            raise RuntimeError('SSE reader did not stop after the response was closed')


