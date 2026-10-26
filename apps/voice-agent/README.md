# Voice agent (`apps/voice-agent`)

A Python LiveKit worker, package `voice_agent`. It joins LiveKit rooms and runs speech
recognition (`VOICE_STT`), turn detection, and speech synthesis (`VOICE_TTS`). It calls
only the gateway's `/api/voice` routes, for call state, call updates, and chat
completions. It does not call the agent server directly.

- Entry point: the `voice-agent` script, `voice_agent.main:run`.
- Dev: `cd apps/voice-agent && uv sync && uv run voice-agent dev`.
- Container: `apps/voice-agent/Dockerfile` runs `uv run --no-sync voice-agent start` as uid 1001.
  The container gets its settings from the environment that Compose passes in; it does not
  read a `.env` file.
- Python: 3.13. The version is pinned in seven places, which must change together: `.python-version`
  (read by `scripts/check.mjs` and CI), `requires-python`, the ruff `target-version` and the pyright
  `pythonVersion` in this app's `pyproject.toml`, the Python tag of the Dockerfile base image, and
  `requires-python` and the ruff `target-version` in
  [`apps/device-client/pyproject.toml`](../device-client/pyproject.toml).
- Check: `pnpm check:voice-agent` (pytest, ruff, and pyright, run with `uv run --locked`).
- Tests: `tests/`. `tests/conftest.py` clears the settings variables and points `VOICE_ENV_FILE`
  at a missing file, so no real `.env` is read.
- Settings: read from the env file named by `VOICE_ENV_FILE`. When that is unset, a source
  checkout uses the repo-root `.env`, and only if it exists; an installed package reads no env
  file. Required: `VOICE_GATEWAY_TOKEN` (must match the gateway; empty or a `change-me` placeholder
  is an error), `GROQ_API_KEY` when `VOICE_STT` is a Groq model (speech-to-text), and
  `DEEPGRAM_API_KEY` when `VOICE_TTS` is a Deepgram model (speech synthesis, read by the Deepgram
  plugin). Also `GATEWAY_URL`, `LIVEKIT_URL`, the LiveKit keys, and `VOICE_*`, as listed in
  [`.env.example`](../../.env.example). `GROQ_BASE_URL` overrides the Groq endpoint. The worker
  checks these at start (`run()`), before it connects to LiveKit.
- Gateway URL: the bearer token is sent to `GATEWAY_URL`, so a remote gateway must use HTTPS.
  Plain HTTP is accepted only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) and single-label
  Compose service names such as `http://gateway:3000`. A LAN address over HTTP is rejected; put the
  gateway behind HTTPS or run the voice agent on the same host. The device client applies the same
  refusal with a narrower allow-list: only the exact names `localhost` and `127.0.0.1`, so
  `http://[::1]:3000` and `http://gateway:3000` are refused there.
- Names: `LIVEKIT_AGENT_NAME` (default `assistant`; an empty value means the default) is the
  LiveKit dispatch name that rooms are sent to. The LLM model name `artemis` is the gateway's
  model name, sent in each chat request. The two are different identifiers on purpose.
