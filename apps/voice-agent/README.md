# Voice agent (`apps/voice-agent`)

A Python LiveKit worker, package `voice_agent`. It joins LiveKit rooms and runs speech
recognition (`VOICE_STT`), turn detection, and speech synthesis (`VOICE_TTS`). It calls
only the gateway's `/api/voice` routes, for call state, call updates, and chat
completions. It does not call the agent server directly.

- Entry point: the `agent` script, `voice_agent.main:run`.
- Dev: `cd apps/voice-agent && uv sync && uv run agent dev`.
- Container: `apps/voice-agent/Dockerfile` runs `uv run --no-sync agent start`.
- Python: `>=3.11, <3.15`, pinned to 3.13 in `.python-version`.
- Check: `pnpm check:voice` (pytest, ruff, and pyright, run with `uv run --locked`).
- Tests: `tests/`.
- Environment: `GATEWAY_URL`, `LIVEKIT_URL`, `VOICE_*`, and the LiveKit keys, as listed in
  [`.env.example`](../../.env.example).
