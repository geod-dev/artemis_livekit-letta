"""Shared PowerShell lookup and invocation for the Windows code paths of built-in scopes."""

import shutil
import subprocess


def powershell_executable(*, core_first=False):
    """Return the first PowerShell found on PATH, or None.

    Windows PowerShell 5.1 (`powershell`) is preferred by default; `core_first` prefers `pwsh`.
    """
    names = ("pwsh", "powershell") if core_first else ("powershell", "pwsh")
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def run_powershell(script, timeout, *, missing_message):
    """Run a PowerShell script and return the completed process; the caller checks returncode."""
    executable = powershell_executable()
    if not executable:
        raise RuntimeError(missing_message)
    return subprocess.run(
        [executable, "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
