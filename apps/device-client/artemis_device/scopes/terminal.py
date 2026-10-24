"""Run shell command lines or explicit executable/argument lists on the device."""

import contextlib
import os
import signal
import subprocess
import threading
from pathlib import Path

from ._powershell import powershell_executable
from .settings import ScopeSettings

MAX_OUTPUT_BYTES = 64_000
COMMAND_TIMEOUT_SECONDS = 30


def _close_pipes_when_read(process, readers):
    for reader in readers:
        reader.join()
    process.stdout.close()
    process.stderr.close()


def command_line(command, argv):
    # An argument list preserves literal values; shell lines use the device's OS.
    if argv or Path(command).is_file():
        return [command, *argv]
    if os.name == "nt":
        powershell = powershell_executable(core_first=True)
        if powershell:
            return [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
                + command,
            ]
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", command]
    return ["/bin/sh", "-c", command]


def register(args: ScopeSettings):
    active_folder = Path(args.active_folder).resolve()

    def execute(arguments):
        command = arguments.get("command")
        argv = arguments.get("arguments", [])
        if not isinstance(command, str) or not command or "\x00" in command:
            raise ValueError("command must be a non-empty executable name or absolute path")
        if not isinstance(argv, list) or any(
            not isinstance(item, str) or "\x00" in item for item in argv
        ):
            raise ValueError("arguments must be a list of strings")
        cwd_arg = arguments.get("cwd", str(active_folder))
        if not isinstance(cwd_arg, str):
            raise ValueError("cwd must be an absolute path")
        cwd = Path(cwd_arg).expanduser()
        if not cwd.is_absolute():
            raise ValueError("Terminal working directory must be absolute")
        cwd = cwd.resolve()
        if not cwd.is_dir():
            raise ValueError("Working directory does not exist")
        process = subprocess.Popen(
            command_line(command, argv),
            cwd=str(cwd),
            shell=False,
            start_new_session=os.name != "nt",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        captured = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = {"stdout": False, "stderr": False}

        def drain(stream, destination):
            while True:
                # read1 returns what has arrived; read(8192) would hold output until the pipe closes.
                chunk = stream.read1(8192)
                if not chunk:
                    return
                remaining = MAX_OUTPUT_BYTES - len(destination)
                if remaining > 0:
                    destination.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    truncated["stdout" if destination is captured["stdout"] else "stderr"] = True

        readers = [
            threading.Thread(target=drain, args=(process.stdout, captured["stdout"]), daemon=True),
            threading.Thread(target=drain, args=(process.stderr, captured["stderr"]), daemon=True),
        ]
        for reader in readers:
            reader.start()
        try:
            return_code = process.wait(timeout=COMMAND_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as error:
            if os.name == "nt":
                with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=5,
                        check=False,
                    )
                if process.poll() is None:
                    process.kill()
            else:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise TimeoutError(
                f"Command exceeded the {COMMAND_TIMEOUT_SECONDS} second limit"
            ) from error
        finally:
            for reader in readers:
                reader.join(timeout=1)
            # A background child can keep a pipe open after the command exits. The pipes are
            # closed only once their readers have finished, by a daemon thread if needed.
            incomplete = any(reader.is_alive() for reader in readers)
            if incomplete:
                threading.Thread(
                    target=_close_pipes_when_read,
                    args=(process, readers),
                    daemon=True,
                ).start()
            else:
                process.stdout.close()
                process.stderr.close()
        stdout = bytes(captured["stdout"]).decode("utf-8", errors="replace")
        stderr = bytes(captured["stderr"]).decode("utf-8", errors="replace")
        stdout_note = "\n[stdout truncated at 64 KB]" if truncated["stdout"] else ""
        stderr_note = "\n[stderr truncated at 64 KB]" if truncated["stderr"] else ""
        incomplete_note = (
            "\n[output incomplete: a child process kept stdout or stderr open after the command "
            "exited]"
            if incomplete
            else ""
        )
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"exit_code: {return_code}\nstdout:\n{stdout}{stdout_note}\n"
                        f"stderr:\n{stderr}{stderr_note}{incomplete_note}"
                    ),
                }
            ]
        }

    shell_name = "PowerShell (cmd fallback)" if os.name == "nt" else "/bin/sh"
    description = f"Execute commands on this PC using {shell_name}. Put the full command line in command and omit arguments (or use an empty list) for shell syntax, quoting, pipes and redirection. Use syntax for this device's OS: Windows PowerShell does not accept Linux ls flags. With a non-empty arguments list, command must be only an executable name or path; arguments are passed literally without shell interpretation. Access is system-wide under the device client account's OS permissions: there is no folder sandbox or restriction to the active folder. Commands can read and write absolute paths anywhere, regardless of cwd. Set cwd to any existing absolute directory on any drive. Default starting directory (context only): {active_folder}. Commands run for up to 30 seconds; output is capped at 64 KB per stream."
    tool = {
        "name": "terminal_run",
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Full shell command line; with non-empty arguments, only an executable name or absolute executable path",
                },
                "arguments": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional literal executable arguments. Omit or leave empty to execute command as a shell command line.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional absolute working directory anywhere on this PC, including outside the active folder and on other drives. The active folder is only the default starting directory, not an access boundary.",
                },
            },
            "required": ["command"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False},
    }
    return [tool], {"terminal_run": execute}
