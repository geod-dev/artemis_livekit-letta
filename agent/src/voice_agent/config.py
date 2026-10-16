"""Configuration for the voice agent, read from the repo-root `.env`."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# One `.env` at the repo root is shared with Docker Compose, the backend and the frontend.
load_dotenv(Path(__file__).resolve().parents[3] / ".env")


@dataclass(frozen=True)
class Settings:
    gateway_url: str
    gateway_token: str
    agent_name: str
    stt: str
    tts: str
    language: str
    greeting: str

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            gateway_url=os.getenv(
                "GATEWAY_URL", f"http://{os.getenv('IP_ADDRESS', '127.0.0.1')}:3000"
            ).rstrip("/"),
            gateway_token=os.getenv("VOICE_GATEWAY_TOKEN", "dev-voice-token-change-me"),
            agent_name=os.getenv("LIVEKIT_AGENT_NAME", "assistant"),
            stt=os.getenv("VOICE_STT", "groq/whisper-large-v3-turbo"),
            tts=os.getenv("VOICE_TTS", "deepgram/flux-hannah-en"),
            language=os.getenv("VOICE_LANGUAGE", "en"),
            greeting=os.getenv("VOICE_GREETING", "Hi, I'm listening."),
        )

    def conversation_base_url(self, conversation_id: str) -> str:
        """OpenAI-compatible base URL of the gateway, scoped to one conversation."""
        return f"{self.gateway_url}/api/voice/conversations/{conversation_id}/v1"
