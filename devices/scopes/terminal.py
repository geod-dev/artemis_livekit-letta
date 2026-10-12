"""Allowlisted local command execution without a shell."""
import os
import shutil
import subprocess
import threading
from pathlib import Path

MAX_OUTPUT_BYTES = 64_000

def register(args):
    allowed = {}
    for name in args.terminal_command:
        executable = shutil.which(name)
        if not executable: raise ValueError(f'Allowlisted terminal command not found on PATH: {name}')
        allowed[Path(name).name.casefold()] = executable
    roots = [Path(path).expanduser().resolve() for path in (args.filesystem_root or [Path.cwd()])]
    def execute(arguments):
        name, argv = arguments.get('command'), arguments.get('arguments', [])
        if not isinstance(name, str) or Path(name).name.casefold() not in allowed: raise ValueError('Command is not on the --terminal-command allowlist')
        if not isinstance(argv, list) or len(argv) > 64 or any(not isinstance(item, str) or '\x00' in item for item in argv): raise ValueError('arguments must be a list of at most 64 strings')
        cwd_arg = arguments.get('cwd', str(roots[0]))
        if not isinstance(cwd_arg, str): raise ValueError('cwd must be a path string')
        cwd = Path(cwd_arg).expanduser().resolve()
        try: within_roots = any(os.path.commonpath((str(root), str(cwd))) == str(root) for root in roots)
        except ValueError: within_roots = False
        if not within_roots: raise ValueError('Working directory is outside the configured filesystem roots')
        if not cwd.is_dir(): raise ValueError('Working directory does not exist')
        process = subprocess.Popen([allowed[Path(name).name.casefold()], *argv], cwd=str(cwd), shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        captured = {'stdout': bytearray(), 'stderr': bytearray()}
        def drain(stream, destination):
            while True:
                chunk = stream.read(8192)
                if not chunk: return
                remaining = MAX_OUTPUT_BYTES - len(destination)
                if remaining > 0: destination.extend(chunk[:remaining])
        readers = [threading.Thread(target=drain, args=(process.stdout, captured['stdout']), daemon=True), threading.Thread(target=drain, args=(process.stderr, captured['stderr']), daemon=True)]
        for reader in readers: reader.start()
        try: return_code = process.wait(timeout=30)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.wait()
            raise TimeoutError('Command exceeded the 30 second limit') from error
        finally:
            for reader in readers: reader.join()
            process.stdout.close()
            process.stderr.close()
        stdout = bytes(captured['stdout']).decode('utf-8', errors='replace')
        stderr = bytes(captured['stderr']).decode('utf-8', errors='replace')
        return {'content': [{'type': 'text', 'text': f'exit_code: {return_code}\nstdout:\n{stdout}\nstderr:\n{stderr}'}]}
    tool = {'name': 'terminal_run', 'description': 'Run an allowlisted command without a shell, in an allowed directory, with a 30 second timeout.', 'inputSchema': {'type': 'object', 'properties': {'command': {'type': 'string'}, 'arguments': {'type': 'array', 'items': {'type': 'string'}}, 'cwd': {'type': 'string'}}, 'required': ['command'], 'additionalProperties': False}, 'annotations': {'readOnlyHint': False}}
    return [tool], {'terminal_run': execute}


