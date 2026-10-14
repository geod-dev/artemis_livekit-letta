#!/bin/sh
set -eu

node /opt/assistant/setup.mjs
LETTA_CODE_VERSION=$(node -e "process.stdout.write(require('/usr/local/lib/node_modules/@letta-ai/letta-code/package.json').version)")
if [ "$LETTA_CODE_VERSION" != "0.34.4" ]; then
  echo "Unsupported Letta Code version: $LETTA_CODE_VERSION (expected 0.34.4)" >&2
  exit 1
fi
export LETTA_CODE_VERSION
if [ -n "${OPENAI_COMPATIBLE_BASE_URL:-}" ]; then
  letta --backend local connect openai-compatible \
    --base-url http://openai-compatible-proxy:8080/v1 \
    --api-key "$OPENAI_COMPATIBLE_API_KEY"
fi
printf %s "$LETTA_SERVER_TOKEN" > /run/letta-token
exec letta --backend local server \
  --listen ws://0.0.0.0:4500 \
  --ws-auth capability-token --ws-token-file /run/letta-token
