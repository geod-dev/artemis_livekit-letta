#!/bin/sh
# Entrypoint of the agent-server image. The container starts as root and this script drops to uid 1001
# (the server) before it runs the command. SETUID and SETGID stay as ambient capabilities after the change,
# so the server can start agent shells as uid 1002 (WORKSPACE_RUN_AS). The workspace runner
# (packages/workspace, vendor/filesystem/process.ts, shellInvocation) clears the inheritable and ambient sets
# for every agent shell, so the shells hold no capabilities and cannot switch back to uid 1001. Keep that
# runner in step with this file. Those are the only capabilities the image needs: Compose grants exactly
# these two after cap_drop ALL. Do not add --securebits: setpriv refuses keep_caps together with a uid
# change, and the ambient set already keeps the two capabilities.
set -eu

exec setpriv --reuid=1001 --regid=1001 --init-groups \
  --inh-caps=+setuid,+setgid --ambient-caps=+setuid,+setgid -- "$@"
