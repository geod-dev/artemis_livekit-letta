"""Capture the current desktop using platform-native screenshot utilities."""
import base64
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from .settings import ScopeSettings

MAX_IMAGE_BYTES = 10_000_000

def register(args: ScopeSettings):
    def capture(_arguments):
        fd, output = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        path = Path(output)
        try:
            if os.name == 'nt':
                powershell = shutil.which('powershell') or shutil.which('pwsh')
                if not powershell: raise RuntimeError('PowerShell is required for screenshots on Windows')
                output_path = str(path).replace("'", "''")
                script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('" + output_path + "',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $i.Dispose()"
                subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, timeout=20, check=True)
            elif sys.platform == 'darwin':
                executable = shutil.which('screencapture')
                if not executable: raise RuntimeError('screencapture was not found')
                subprocess.run([executable, '-x', str(path)], capture_output=True, timeout=20, check=True)
            else:
                executable = shutil.which('gnome-screenshot')
                if executable: command = [executable, '-f', str(path)]
                else:
                    executable = shutil.which('scrot')
                    if not executable: raise RuntimeError('Install gnome-screenshot or scrot to enable desktop capture')
                    command = [executable, str(path)]
                subprocess.run(command, capture_output=True, timeout=20, check=True)
            data = path.read_bytes()
            if not data or len(data) > MAX_IMAGE_BYTES: raise RuntimeError('Screenshot is empty or exceeds the 10 MB limit')
            return {'content': [{'type': 'image', 'data': base64.b64encode(data).decode('ascii'), 'mimeType': 'image/png'}]}
        finally: path.unlink(missing_ok=True)
    tool = {'name': 'screenshot_capture', 'description': 'Capture the primary desktop and return it as a PNG image.', 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}, 'annotations': {'readOnlyHint': True}}
    return [tool], {'screenshot_capture': capture}
