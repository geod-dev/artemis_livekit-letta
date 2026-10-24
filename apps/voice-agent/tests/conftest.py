"""Isolate every test from the developer's real environment and `.env` file."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

SETTINGS_VARIABLES = (
    "VOICE_GATEWAY_TOKEN",
    "GATEWAY_URL",
    "IP_ADDRESS",
    "LIVEKIT_AGENT_NAME",
    "VOICE_STT",
    "VOICE_TTS",
    "VOICE_LANGUAGE",
    "VOICE_GREETING",
    "GROQ_BASE_URL",
    "GROQ_API_KEY",
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
)


@pytest.fixture(autouse=True)
def isolated_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[Path]:
    for name in SETTINGS_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    # Point the env file at a path that does not exist, so no `.env` is read.
    missing = tmp_path / "missing.env"
    monkeypatch.setenv("VOICE_ENV_FILE", str(missing))
    yield missing
