#!/usr/bin/env python3
"""Deploy new main commits through Coolify; keep credentials on the VPS."""
import fcntl
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

CONFIG = Path('/etc/artemis/coolify-deploy.json')
STATE = Path('/var/lib/artemis-deploy/state.json')
ACTIVE = {'queued', 'in_progress', 'pending', 'running'}


def save(state):
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    os.chmod(temporary, 0o600)
    temporary.replace(STATE)


def main():
    config = json.loads(CONFIG.read_text())
    token = Path(config['token_file']).read_text().strip()
    app = config['application_uuid']

    def api(method, path, body=None):
        request = urllib.request.Request(
            'http://127.0.0.1:8000/api/v1' + path,
            method=method,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode(),
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    if state.get('pending'):
        deployment = api('GET', '/deployments/' + state['pending']['uuid'])
        status = deployment['status']
        if status in ACTIVE:
            return
        requested = state.pop('pending')['commit']
        if status == 'finished':
            actual = deployment.get('commit') or requested
            state['deployed'] = actual if re.fullmatch(r'[0-9a-f]{40}', actual) else requested
            state.pop('failed', None)
            print('Coolify deployment finished:', state['deployed'], flush=True)
        else:
            state['failed'] = requested
            print('Coolify deployment', status + ':', requested, flush=True)
        save(state)

    result = subprocess.run(
        ['git', 'ls-remote', '--exit-code', config['repository'], 'refs/heads/' + config['branch']],
        check=True, capture_output=True, text=True, timeout=30,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
    )
    latest = result.stdout.split()[0]
    if not re.fullmatch(r'[0-9a-f]{40}', latest):
        raise ValueError('Invalid commit returned by Git')
    if latest in {state.get('deployed'), state.get('failed')}:
        return

    history = api('GET', '/deployments/applications/' + app + '?skip=0&take=5')
    deployments = history.get('deployments', []) if isinstance(history, dict) else history
    if any(item['status'] in ACTIVE for item in deployments):
        return

    response = api('POST', '/deploy', {'uuid': app, 'force': False})
    queued = response['deployments'][0]
    if queued['resource_uuid'] != app or not queued.get('deployment_uuid'):
        raise ValueError('Unexpected deployment response')
    state['pending'] = {'uuid': queued['deployment_uuid'], 'commit': latest}
    save(state)
    print('New commit queued in Coolify:', latest, queued['deployment_uuid'], flush=True)


if __name__ == '__main__':
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE.parent / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit(0)
        try:
            main()
        except Exception as error:
            # Error messages omit credentials and response bodies.
            print('Automatic deployment check failed:', type(error).__name__, str(error), file=sys.stderr)
            sys.exit(1)
