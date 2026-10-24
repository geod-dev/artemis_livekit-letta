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
- Python: 3.13. The version is pinned in four places, which must change together: `.python-version`
  (read by `scripts/check.mjs` and CI), `requires-python` and the ruff `target-version` in
  `pyproject.toml`, the pyright `pythonVersion` in `pyproject.toml`, and the Python tag of the
  Dockerfile base image.
- Check: `pnpm check:voice` (pytest, ruff, and pyright, run with `uv run --locked`).
- Tests: `tests/`. `tests/conftest.py` clears the settings variables and points `VOICE_ENV_FILE`
  at a missing file, so no real `.env` is read.
- Settings: read from the env file named by `VOICE_ENV_FILE`. When that is unset, the repo-root
  `.env` is used, and only if it exists. Required: `VOICE_GATEWAY_TOKEN` (must match the gateway;
  empty is an error), `GROQ_API_KEY` (speech-to-text), and `DEEPGRAM_API_KEY` (speech synthesis,
  read by the Deepgram plugin). Also `GATEWAY_URL`, `LIVEKIT_URL`, the LiveKit keys, and
  `VOICE_*`, as listed in [`.env.example`](../../.env.example). `GROQ_BASE_URL` overrides the
  Groq endpoint. Settings are validated when the worker starts.
- Gateway URL: the bearer token is sent to `GATEWAY_URL`, so a remote gateway must use HTTPS.
  Plain HTTP is accepted only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) and single-label
  Compose service names such as `http://gateway:3000`. A LAN address over HTTP is rejected; put the
  gateway behind HTTPS or run the voice agent on the same host.
- Names: `LIVEKIT_AGENT_NAME` (default `assistant`) is the LiveKit dispatch name that rooms are
  sent to. The LLM model name `artemis` is the backend's model name, sent in each chat request.
  The two are different identifiers on purpose.
