"""Groq transcription and Deepgram speech synthesis for voice calls."""

from __future__ import annotations

import os
from dataclasses import dataclass

from livekit.agents import inference, stt, tts
from livekit.agents.voice.turn import TurnDetectionMode
from livekit.plugins import deepgram, openai


@dataclass
class SpeechStack:
    stt: stt.STT
    tts: tts.TTS
    turn_detection: TurnDetectionMode


def _split(spec: str) -> tuple[str, str]:
    provider, _, model = spec.partition("/")
    if not model:
        raise ValueError(f"Expected '<provider>/<model>', got {spec!r}")
    return provider.lower(), model


def build_speech(stt_spec: str, tts_spec: str, language: str) -> SpeechStack:
    stt_provider, stt_model = _split(stt_spec)
    tts_provider, tts_model = _split(tts_spec)
    if stt_provider != "groq":
        raise ValueError(f"Unsupported STT provider {stt_provider!r}")
    if tts_provider != "deepgram":
        raise ValueError(f"Unsupported TTS provider {tts_provider!r}")
    # Groq serves the transcription protocol through its own API and credentials.
    transcription = openai.STT(
        model=stt_model,
        language=language,
        base_url="https://api.groq.com/openai/v1",
        api_key=os.environ["GROQ_API_KEY"],
        use_realtime=False,
    )
    synthesis = (
        deepgram.TTSv2(model=tts_model)
        if tts_model.startswith("flux")
        else deepgram.TTS(model=tts_model)
    )
    return SpeechStack(
        stt=transcription,
        tts=synthesis,
        turn_detection=inference.TurnDetector(version="v1-mini"),
    )
