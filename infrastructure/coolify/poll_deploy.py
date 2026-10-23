#!/usr/bin/env python3
"""Deploy new main commits through Coolify; keep credentials on the VPS."""
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

CONFIG = Path('/etc/artemis/coolify-deploy.json')
STATE = Path('/var/lib/artemis-deploy/state.json')
ACTIVE = {'queued', 'in_progress', 'pending', 'running'}
COMMIT = re.compile(r'^[0-9a-f]{40}$')


def save(state):
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    os.chmod(temporary, 0o600)
    temporary.replace(STATE)


def poll(state, latest, application, api):
    """Advance a deployment using the API callable; returns updated state."""
    if state.get('pending'):
        pending = state['pending']
        deployment = api('GET', '/deployments/' + pending['uuid'])
        status = deployment.get('status')
        if status in ACTIVE:
            return state
        requested = pending['commit']
        state.pop('pending')
        actual = deployment.get('commit')
        if status == 'finished' and COMMIT.fullmatch(actual or '') and actual == requested:
            state['deployed'] = actual
            state.pop('failed', None)
            print('Coolify deployment finished:', actual, flush=True)
        else:
            # Failed hashes are held to avoid a retry loop. Advancing main clears
            # the hold; an operator can retry the same hash from Coolify.
            state['failed'] = requested
            reason = 'revision missing or mismatched' if status == 'finished' else status
            print('Coolify deployment not accepted:', reason, requested, flush=True)
    if not COMMIT.fullmatch(latest or ''):
        raise ValueError('Invalid commit returned by Git')
    if latest in {state.get('deployed'), state.get('failed')}:
        return state

    history = api('GET', '/deployments/applications/' + application + '?skip=0&take=5')
    deployments = history.get('deployments', []) if isinstance(history, dict) else history
    if any(item.get('status') in ACTIVE for item in deployments):
        return state

    response = api('POST', '/deploy', {'uuid': application, 'force': False})
    queued = (response.get('deployments') or [{}])[0]
    if queued.get('resource_uuid') != application or not queued.get('deployment_uuid'):
        raise ValueError('Unexpected deployment response')
    state['pending'] = {'uuid': queued['deployment_uuid'], 'commit': latest}
    print('New commit queued in Coolify:', latest, queued['deployment_uuid'], flush=True)
    return state


def main():
    config = json.loads(CONFIG.read_text())
    token = Path(config['token_file']).read_text().strip()
    application = config['application_uuid']

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
    result = subprocess.run(
        ['git', 'ls-remote', '--exit-code', config['repository'], 'refs/heads/' + config['branch']],
        check=True, capture_output=True, text=True, timeout=30,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
    )
    latest = result.stdout.split()[0]
    save(poll(state, latest, application, api))


if __name__ == '__main__':
    import fcntl

    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE.parent / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        main()
