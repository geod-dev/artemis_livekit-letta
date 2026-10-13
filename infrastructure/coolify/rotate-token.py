#!/usr/bin/env python3
"""Rotate the local read/deploy token monthly, with a 90-day expiration."""
import fcntl
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path


def console(code):
    result = subprocess.run(
        ['docker', 'exec', 'coolify', 'php', 'artisan', 'tinker', '--execute=' + code],
        check=True, capture_output=True, text=True, timeout=60,
    )
    return json.loads(result.stdout.strip())


with Path('/var/lib/artemis-deploy/lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    config = json.loads(Path('/etc/artemis/coolify-deploy.json').read_text())
    issued = console('''
        session(["currentTeam"=>App\\Models\\Team::findOrFail(0)]);
        $u=App\\Models\\User::findOrFail(0);
        $old=$u->tokens()->where("team_id",0)->where("name","Artemis automatic deployment")->pluck("id");
        $t=$u->createToken("Artemis automatic deployment",["read","deploy"],now()->addDays(90));
        echo json_encode(["token"=>$t->plainTextToken,"previous"=>$old]);
    ''')
    request = urllib.request.Request(
        'http://127.0.0.1:8000/api/v1/applications/' + config['application_uuid'],
        headers={'Authorization': 'Bearer ' + issued['token']},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        application = json.load(response)
        if application['uuid'] != config['application_uuid']:
            raise ValueError('Unexpected application while validating new token')
    destination = Path(config['token_file'])
    with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent, delete=False) as temporary:
        temporary.write(issued['token'])
        os.chmod(temporary.name, 0o600)
    os.replace(temporary.name, destination)
    previous = [int(token_id) for token_id in issued['previous']]
    if previous:
        console('''
            $n=App\\Models\\User::findOrFail(0)->tokens()
                ->where("team_id",0)->where("name","Artemis automatic deployment")
                ->whereIn("id",''' + json.dumps(previous) + ''')->delete();
            echo json_encode(["revoked"=>$n]);
        ''')
    print('Local read/deploy token renewed for 90 days; previous tokens revoked.')
