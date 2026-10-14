"""Open HTTP(S) URLs in the device's default browser or Firefox."""
import os
import shutil
import subprocess
import sys
import urllib.parse
from .settings import ScopeSettings

def open_url(arguments, firefox=None):
    url = arguments.get('url')
    if not isinstance(url, str) or any(ord(char) < 32 for char in url): raise ValueError('A valid HTTP or HTTPS URL is required')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname: raise ValueError('Only HTTP and HTTPS URLs are allowed')
    executable = firefox or shutil.which('firefox')
    if executable: command = [executable, '--new-tab', url]
    elif os.name == 'nt':
        os.startfile(url)
        return {'content': [{'type': 'text', 'text': 'Opened URL in the default browser.'}]}
    else:
        opener = shutil.which('open' if sys.platform == 'darwin' else 'xdg-open')
        if not opener: raise RuntimeError('No Firefox or system URL opener was found.')
        command = [opener, url]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {'content': [{'type': 'text', 'text': 'Opened URL in the browser.'}]}

def register(args: ScopeSettings):
    tool = {'name': 'open_url', 'description': 'Open an HTTP or HTTPS URL in the device browser.', 'inputSchema': {'type': 'object', 'properties': {'url': {'type': 'string'}}, 'required': ['url'], 'additionalProperties': False}, 'annotations': {'readOnlyHint': False}}
    return [tool], {'open_url': lambda arguments: open_url(arguments, args.firefox)}
