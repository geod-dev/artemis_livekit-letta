# Voice agent (`apps/voice-agent`)

A Python LiveKit worker, package `voice_agent`. It joins LiveKit rooms and runs speech
recognition (`VOICE_STT`), turn detection, and speech synthesis (`VOICE_TTS`). It calls
only the gateway's `/api/voice` routes, for call state, call updates, and chat
completions. It does not call the agent server directly.

- Entry point: the `voice-agent` script, `voice_agent.main:run`.
- Dev: `cd apps/voice-agent && uv sync && uv run voice-agent dev`.
- Container: `apps/voice-agent/Dockerfile` runs `uv run --no-sync voice-agent start` as uid 1001.
- Python: 3.13 (`.python-version` is the single pin; `requires-python` is `>=3.13`).
- Check: `pnpm check:voice` (pytest, ruff, and pyright, run with `uv run --locked`).
- Tests: `tests/`.
- Settings are read from the repo-root `.env` (`REPO_ROOT/.env`). Required: `VOICE_GATEWAY_TOKEN`
  (must match the gateway; empty is an error), `GROQ_API_KEY` (speech-to-text), and
  `DEEPGRAM_API_KEY` (speech synthesis, read by the Deepgram plugin). Also `GATEWAY_URL`,
  `LIVEKIT_URL`, the LiveKit keys, and `VOICE_*`, as listed in
  [`.env.example`](../../.env.example). `GROQ_BASE_URL` overrides the Groq endpoint.
