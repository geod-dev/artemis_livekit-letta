#!/usr/bin/env python3
"""Rotate the local read/deploy token monthly, with a 90-day expiration."""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

CONFIG = Path('/etc/artemis/coolify-deploy.json')
LOCK = Path('/var/lib/artemis-deploy/lock')


def console(code):
    result = subprocess.run(
        ['docker', 'exec', 'coolify', 'php', 'artisan', 'tinker', '--execute=' + code],
        check=True, capture_output=True, text=True, timeout=60,
    )
    # Tinker may print warnings before the result; the JSON result is the last non-empty line.
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise ValueError('Coolify console printed no result')
    return json.loads(lines[-1])


def rotate(config, run_console=console, open_url=urllib.request.urlopen):
    issued = run_console('''
        session(["currentTeam"=>App\\Models\\Team::findOrFail(0)]);
        $u=App\\Models\\User::findOrFail(0);
        $old=$u->tokens()->where("team_id",0)->where("name","Artemis automatic deployment")->pluck("id");
        $t=$u->createToken("Artemis automatic deployment",["read","deploy"],now()->addDays(90));
        echo json_encode(["token"=>$t->plainTextToken,"id"=>$t->accessToken->id,"previous"=>$old]);
    ''')
    token_id = int(issued['id'])
    token = issued['token']
    destination = Path(config['token_file'])
    request = urllib.request.Request(
        'http://127.0.0.1:8000/api/v1/applications/' + config['application_uuid'],
        headers={'Authorization': 'Bearer ' + token},
    )
    try:
        with open_url(request, timeout=30) as response:
            application = json.load(response)
        if application.get('uuid') != config['application_uuid']:
            raise ValueError('Unexpected application while validating new token')
    except Exception:
        # A failed validation must not leave an extra live credential behind.
        run_console('''
            $n=App\\Models\\User::findOrFail(0)->tokens()->where("team_id",0)
                ->where("name","Artemis automatic deployment")->where("id",''' + str(token_id) + ''')->delete();
            echo json_encode(["revoked"=>$n]);
        ''')
        raise

    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent, delete=False) as temporary:
            temporary_name = temporary.name
            temporary.write(token)
            os.chmod(temporary.name, 0o600)
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)

    previous = [int(previous_id) for previous_id in issued.get('previous', [])]
    if previous:
        try:
            run_console('''
                $n=App\\Models\\User::findOrFail(0)->tokens()
                    ->where("team_id",0)->where("name","Artemis automatic deployment")
                    ->whereIn("id",''' + json.dumps(previous) + ''')->delete();
                echo json_encode(["revoked"=>$n]);
            ''')
        except Exception:
            # The new token is already installed, so the old ones are still valid until revoked.
            # Report them for the operator and fail the unit so the failure is visible.
            print('Local token renewed, but revocation of previous token ids was not confirmed. '
                  'Still live unless revoked: ' + ', '.join(str(previous_id) for previous_id in previous)
                  + '. Revoke them in Coolify; the next monthly run also revokes them.', file=sys.stderr)
            raise SystemExit(1)
    print('Local read/deploy token renewed for 90 days; previous tokens revoked.')


if __name__ == '__main__':
    import fcntl

    LOCK.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with LOCK.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rotate(json.loads(CONFIG.read_text()))
