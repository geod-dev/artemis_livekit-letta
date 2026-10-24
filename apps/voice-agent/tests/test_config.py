import os
from pathlib import Path

import pytest

from voice_agent import config
from voice_agent.config import Settings, load_env_file, require_secure_gateway_url

# tests/test_config.py -> apps/voice-agent/tests -> apps/voice-agent -> apps -> repository root.
REPO = Path(__file__).resolve().parents[3]


def test_default_env_file_is_the_checkout_dotenv(monkeypatch):
    monkeypatch.delenv(config.ENV_FILE_VARIABLE, raising=False)
    assert config.DEFAULT_ENV_FILE == REPO / ".env"
    assert config.env_file() == REPO / ".env"


def test_env_file_is_configurable(monkeypatch, tmp_path):
    target = tmp_path / "voice.env"
    monkeypatch.setenv(config.ENV_FILE_VARIABLE, str(target))
    assert config.env_file() == target


def test_missing_env_file_is_not_loaded(monkeypatch, tmp_path):
    monkeypatch.setenv(config.ENV_FILE_VARIABLE, str(tmp_path / "absent.env"))
    assert load_env_file() is None


def test_existing_env_file_is_loaded(monkeypatch, tmp_path):
    target = tmp_path / "voice.env"
    target.write_text("VOICE_LANGUAGE=de\n", encoding="utf-8")
    monkeypatch.setenv(config.ENV_FILE_VARIABLE, str(target))
    # Registers VOICE_LANGUAGE for removal at teardown, since load_dotenv sets it directly.
    monkeypatch.setenv("VOICE_LANGUAGE", "en")
    assert load_env_file() == target
    assert os.environ["VOICE_LANGUAGE"] == "en"  # an existing variable is not overridden
    monkeypatch.delenv("VOICE_LANGUAGE")
    assert load_env_file() == target
    assert os.environ["VOICE_LANGUAGE"] == "de"


def test_empty_gateway_token_is_rejected(monkeypatch):
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "")
    with pytest.raises(RuntimeError, match="VOICE_GATEWAY_TOKEN is empty"):
        Settings.from_env()


def test_defaults_come_from_settings(monkeypatch):
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "test-token")
    monkeypatch.setenv("IP_ADDRESS", "127.0.0.1")
    settings = Settings.from_env()
    assert settings.gateway_url == f"http://127.0.0.1:{config.DEFAULT_GATEWAY_PORT}"
    assert settings.gateway_token == "test-token"
    assert settings.agent_name == config.DEFAULT_AGENT_NAME
    assert settings.groq_base_url == config.DEFAULT_GROQ_BASE_URL


def test_remote_plain_http_gateway_is_rejected(monkeypatch):
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "test-token")
    monkeypatch.setenv("GATEWAY_URL", "http://203.0.113.7:3000")
    with pytest.raises(ValueError, match="use HTTPS"):
        Settings.from_env()


@pytest.mark.parametrize(
    "url",
    [
        "https://voice.example.com",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
        "http://gateway:3000",
        "https://203.0.113.7:3000",
    ],
)
def test_allowed_gateway_urls(url):
    assert require_secure_gateway_url(url) == url


@pytest.mark.parametrize(
    "url",
    ["http://voice.example.com", "http://192.168.1.20:3000", "ftp://gateway:3000", "gateway"],
)
def test_rejected_gateway_urls(url):
    with pytest.raises(ValueError):
        require_secure_gateway_url(url)


def test_conversation_id_is_quoted_in_the_base_url():
    settings = Settings(
        gateway_url="https://gateway.example.com",
        gateway_token="t",
        agent_name="assistant",
        stt="groq/whisper-large-v3-turbo",
        tts="deepgram/flux-hannah-en",
        language="en",
        greeting="",
        groq_base_url=config.DEFAULT_GROQ_BASE_URL,
    )
    assert settings.conversation_base_url("a/b?c") == (
        "https://gateway.example.com/api/voice/conversations/a%2Fb%3Fc/v1"
    )
