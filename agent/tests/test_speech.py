import pytest
from livekit.agents import inference
from livekit.plugins import deepgram, telnyx

from voice_agent.config import Settings
from voice_agent.speech import build_speech


@pytest.fixture(autouse=True)
def fake_keys(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test")
    monkeypatch.setenv("TELNYX_API_KEY", "test")


def test_deepgram_flux_drives_turn_detection():
    stack = build_speech("deepgram/flux-general-multi", "deepgram/flux-hannah-en", "", "en")
    assert isinstance(stack.stt, deepgram.STTv2)
    assert isinstance(stack.tts, deepgram.TTSv2)
    assert stack.turn_detection == "stt"


def test_non_flux_stt_uses_local_turn_detector():
    stack = build_speech("telnyx/telnyx", "telnyx/Telnyx.NaturalHD.astra", "", "en")
    assert isinstance(stack.stt, telnyx.STT)
    assert isinstance(stack.tts, telnyx.TTS)
    assert isinstance(stack.turn_detection, inference.TurnDetector)


@pytest.mark.parametrize("spec", ["deepgram", "nope/model"])
def test_invalid_specs_are_rejected(spec):
    with pytest.raises(ValueError):
        build_speech(spec, "deepgram/flux-hannah-en", "", "en")


def test_gateway_url_is_scoped_to_the_conversation():
    settings = Settings.from_env()
    assert settings.conversation_base_url("conv-1").endswith("/api/voice/conversations/conv-1/v1")
