import pytest
from livekit.agents import inference
from livekit.plugins import deepgram, openai

from voice_agent.config import Settings
from voice_agent.speech import build_speech


@pytest.fixture(autouse=True)
def fake_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test")
    monkeypatch.setenv("GROQ_API_KEY", "groq-test")


def test_groq_transcription_uses_its_own_endpoint_and_key():
    stack = build_speech("groq/whisper-large-v3-turbo", "deepgram/flux-hannah-en", "en")
    assert isinstance(stack.stt, openai.STT)
    assert stack.stt.model == "whisper-large-v3-turbo"
    assert stack.stt.provider == "api.groq.com"
    assert str(stack.stt._client.base_url) == "https://api.groq.com/openai/v1/"
    assert stack.stt._client.api_key == "groq-test"
    assert not stack.stt.capabilities.streaming
    assert isinstance(stack.tts, deepgram.TTSv2)
    assert isinstance(stack.turn_detection, inference.TurnDetector)


def test_deepgram_aura_synthesis():
    stack = build_speech("groq/whisper-large-v3-turbo", "deepgram/aura-2-thalia-en", "en")
    assert isinstance(stack.tts, deepgram.TTS)


@pytest.mark.parametrize("spec", ["groq", "nope/model"])
def test_invalid_stt_specs_are_rejected(spec):
    with pytest.raises(ValueError):
        build_speech(spec, "deepgram/flux-hannah-en", "en")


def test_unsupported_tts_is_rejected():
    with pytest.raises(ValueError):
        build_speech("groq/whisper-large-v3-turbo", "nope/model", "en")


def test_missing_groq_key_is_a_descriptive_error(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "  ")
    with pytest.raises(RuntimeError, match="GROQ_API_KEY is empty"):
        build_speech("groq/whisper-large-v3-turbo", "deepgram/flux-hannah-en", "en")


def test_groq_base_url_is_a_parameter():
    stack = build_speech(
        "groq/whisper-large-v3-turbo",
        "deepgram/flux-hannah-en",
        "en",
        groq_base_url="https://groq.example.invalid/v1",
    )
    assert str(stack.stt._client.base_url) == "https://groq.example.invalid/v1/"


def test_gateway_url_is_scoped_to_the_conversation(monkeypatch):
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "test-token")
    settings = Settings.from_env()
    assert settings.conversation_base_url("conv-1").endswith("/api/voice/conversations/conv-1/v1")
