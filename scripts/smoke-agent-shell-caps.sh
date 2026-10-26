#!/bin/sh
# Container check of the agent shell capability reset (R4-DP-001). Needs Docker, so it is not part of
# `pnpm check`; CI runs it after the agent-server image is built.
#
# Usage: sh scripts/smoke-agent-shell-caps.sh [image]   (default: artemis-agent-server:latest)
#
# The image runs with the capability set from docker-compose.yml. The entrypoint starts a stand-in server
# process as uid 1001 with a canary in its environment. That process starts an agent shell through the
# workspace runner (startProcess with runAs 1002:1001), as the server does. From inside the shell:
#   - CapEff must be 0000000000000000;
#   - `setpriv --reuid=1001` must be refused;
#   - the stand-in server's /proc/<pid>/environ must not be readable (it holds the canary).
# Exits 0 with PASS, or 1 with FAIL and the reason.
set -eu

image="${1:-artemis-agent-server:latest}"
canary="smoke-canary-$$"

# Runs inside the image as the stand-in server (uid 1001). Imports the runner from the image.
probe=$(cat <<'EOF'
const { startProcess } = await import('file:///app/packages/workspace/src/vendor/filesystem/process.ts');
const server = process.pid;
const canary = process.env.SMOKE_CANARY;
const script = [
  'echo "uid=$(id -u)"',
  'grep -E "^Cap(Eff|Prm|Inh|Amb):" /proc/$$/status',
  'setpriv --reuid=1001 --regid=1001 --init-groups -- true; echo "setuid_rc=$?"',
  'setpriv --reuid=1001 --regid=1001 --init-groups -- sh -c "grep -a -q ' + canary + ' /proc/' + server + '/environ" && echo environ_read=yes || echo environ_read=no',
].join('\n');
const proc = await startProcess({
  command: script,
  shell: '/bin/sh',
  cwd: '/tmp',
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
  runAs: { uid: 1002, gid: 1001 },
});
await proc.exited;
const out = proc.tail();
process.stdout.write(out.stdout);
process.stderr.write(out.stderr);
EOF
)

out=$(timeout 180 docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true \
  -e SMOKE_CANARY="$canary" \
  "$image" \
  node --experimental-transform-types --input-type=module -e "$probe") || {
  echo "FAIL: the container run failed (image: $image)"
  exit 1
}
printf '%s\n' "$out"

shell_uid=$(printf '%s\n' "$out" | sed -n 's/^uid=//p')
cap_eff=$(printf '%s\n' "$out" | awk -F'[:[:space:]]+' '/^CapEff:/ { print $2 }')
setuid_rc=$(printf '%s\n' "$out" | sed -n 's/^setuid_rc=//p')
environ_read=$(printf '%s\n' "$out" | sed -n 's/^environ_read=//p')

fail=0
if [ "$shell_uid" != "1002" ]; then
  echo "FAIL: agent shell runs as uid '$shell_uid', expected 1002"
  fail=1
fi
if [ "$cap_eff" != "0000000000000000" ]; then
  echo "FAIL: agent shell CapEff is '$cap_eff', expected 0000000000000000"
  fail=1
fi
if [ -z "$setuid_rc" ] || [ "$setuid_rc" = "0" ]; then
  echo "FAIL: agent shell could switch to uid 1001 (setpriv rc '$setuid_rc', expected non-zero)"
  fail=1
fi
if [ "$environ_read" != "no" ]; then
  echo "FAIL: agent shell could read the server's environment (environ_read '$environ_read')"
  fail=1
fi
if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "PASS: CapEff 0, setuid to 1001 refused, server environment unreadable (image: $image)"
