from pathlib import Path

import pytest

from voice_agent import config
from voice_agent.config import Settings

# tests/test_config.py -> apps/voice-agent/tests -> apps/voice-agent -> apps -> repository root.
REPO = Path(__file__).resolve().parents[3]


def test_env_file_is_the_repo_root_dotenv():
    assert config.REPO_ROOT == REPO
    assert config.ENV_FILE == REPO / ".env"


def test_empty_gateway_token_is_rejected(monkeypatch):
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "")
    with pytest.raises(RuntimeError, match="VOICE_GATEWAY_TOKEN is empty"):
        Settings.from_env()


def test_defaults_come_from_settings(monkeypatch):
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "test-token")
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    monkeypatch.setenv("IP_ADDRESS", "10.0.0.5")
    monkeypatch.delenv("GROQ_BASE_URL", raising=False)
    settings = Settings.from_env()
    assert settings.gateway_url == f"http://10.0.0.5:{config.DEFAULT_GATEWAY_PORT}"
    assert settings.gateway_token == "test-token"
    assert settings.groq_base_url == config.DEFAULT_GROQ_BASE_URL
