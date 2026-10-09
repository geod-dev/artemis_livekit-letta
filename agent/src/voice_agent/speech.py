"""Speech provider selection from "<provider>/<model-or-voice>" strings.

Keeping this a small table makes STT/TTS swappable through `.env` without
touching the agent. Add a branch here to support another plugin.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

from livekit.agents import NOT_GIVEN, inference, stt, tts
from livekit.agents.voice.turn import TurnDetectionMode

# Plugins register themselves on import, which must happen on the main thread
# (jobs run in threads on Windows), so import them all up front.
from livekit.plugins import cartesia, deepgram, elevenlabs, openai, telnyx


@dataclass
class SpeechStack:
    stt: stt.STT | str
    tts: tts.TTS | str
    turn_detection: TurnDetectionMode


def _split(spec: str) -> tuple[str, str]:
    provider, _, model = spec.partition("/")
    if not model:
        raise ValueError(f"Expected '<provider>/<model>', got {spec!r}")
    return provider.lower(), model


def build_stt(spec: str, language: str) -> tuple[stt.STT | str, TurnDetectionMode]:
    provider, model = _split(spec)
    if provider == "deepgram":
        if model.startswith("flux"):
            # Flux detects end-of-turn itself; let the STT drive turn taking.
            if model.endswith("multi") and language:
                return deepgram.STTv2(model=model, language_hint=[language]), "stt"
            return deepgram.STTv2(model=model), "stt"
        return deepgram.STT(model=model, language=language), _local_turn_detector()
    if provider == "telnyx":
        engine = cast(Any, model)  # validated by the plugin
        return telnyx.STT(transcription_engine=engine, language=language), _local_turn_detector()
    if provider == "openai":
        return openai.STT(model=model, language=language), _local_turn_detector()
    if provider == "inference":
        return inference.STT(model=model, language=language), _local_turn_detector()
    raise ValueError(f"Unsupported STT provider {provider!r}")


def build_tts(spec: str, voice: str) -> tts.TTS | str:
    provider, model = _split(spec)
    if provider == "deepgram":
        # Flux voices ("flux-<voice>-<lang>") use the v2 streaming endpoint.
        return (
            deepgram.TTSv2(model=model) if model.startswith("flux") else deepgram.TTS(model=model)
        )
    if provider == "telnyx":
        return telnyx.TTS(voice=model)
    if provider == "openai":
        return openai.TTS(model=model, voice=cast(Any, voice or "alloy"))
    if provider == "cartesia":
        return cartesia.TTS(model=model, voice=voice) if voice else cartesia.TTS(model=model)
    if provider == "elevenlabs":
        if voice:
            return elevenlabs.TTS(model=model, voice_id=voice)
        return elevenlabs.TTS(model=model)
    if provider == "inference":
        return inference.TTS(model=model, voice=voice or NOT_GIVEN)
    raise ValueError(f"Unsupported TTS provider {provider!r}")


def _local_turn_detector() -> TurnDetectionMode:
    # Runs locally (bundled weights); works with a self-hosted LiveKit server.
    return inference.TurnDetector(version="v1-mini")


def build_speech(stt_spec: str, tts_spec: str, voice: str, language: str) -> SpeechStack:
    stt_impl, turn_detection = build_stt(stt_spec, language)
    return SpeechStack(stt=stt_impl, tts=build_tts(tts_spec, voice), turn_detection=turn_detection)
