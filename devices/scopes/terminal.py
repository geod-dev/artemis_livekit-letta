"""Run any installed command on the device without a shell wrapper."""
import subprocess
import threading
from pathlib import Path

MAX_OUTPUT_BYTES = 64_000


def register(args):
    active_folder = Path(args.active_folder).resolve()

    def execute(arguments):
        command = arguments.get('command')
        argv = arguments.get('arguments', [])
        if not isinstance(command, str) or not command or '\x00' in command:
            raise ValueError('command must be a non-empty executable name or absolute path')
        if not isinstance(argv, list) or any(not isinstance(item, str) or '\x00' in item for item in argv):
            raise ValueError('arguments must be a list of strings')
        cwd_arg = arguments.get('cwd', str(active_folder))
        if not isinstance(cwd_arg, str): raise ValueError('cwd must be an absolute path')
        cwd = Path(cwd_arg).expanduser()
        if not cwd.is_absolute(): raise ValueError('Terminal working directory must be absolute')
        cwd = cwd.resolve()
        if not cwd.is_dir(): raise ValueError('Working directory does not exist')
        process = subprocess.Popen([command, *argv], cwd=str(cwd), shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
            for reader in readers: reader.join(timeout=1)
            process.stdout.close()
            process.stderr.close()
        stdout = bytes(captured['stdout']).decode('utf-8', errors='replace')
        stderr = bytes(captured['stderr']).decode('utf-8', errors='replace')
        return {'content': [{'type': 'text', 'text': f'exit_code: {return_code}\nstdout:\n{stdout}\nstderr:\n{stderr}'}]}

    description = f'Run any installed command on this PC. Access is system-wide under the device client account\'s OS permissions: there is no folder sandbox or restriction to the active folder. Commands can read and write absolute paths anywhere, regardless of cwd. Set cwd to any existing absolute directory on any drive. Default starting directory (context only): {active_folder}. No implicit shell: pass executable and arguments separately, or explicitly launch PowerShell, cmd, bash, etc. Commands run for up to 30 seconds; output is capped at 64 KB per stream.'
    tool = {'name': 'terminal_run', 'description': description, 'inputSchema': {'type': 'object', 'properties': {'command': {'type': 'string', 'description': 'Executable name on PATH or an absolute executable path'}, 'arguments': {'type': 'array', 'items': {'type': 'string'}}, 'cwd': {'type': 'string', 'description': 'Optional absolute working directory anywhere on this PC, including outside the active folder and on other drives. The active folder is only the default starting directory, not an access boundary.'}}, 'required': ['command'], 'additionalProperties': False}, 'annotations': {'readOnlyHint': False}}
    return [tool], {'terminal_run': execute}
