"""Configuration for the voice agent, read from the repo-root `.env`."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# apps/voice-agent/src/voice_agent/config.py -> the repository root.
REPO_ROOT = Path(__file__).resolve().parents[4]
ENV_FILE = REPO_ROOT / ".env"

# One `.env` at the repo root is shared with Docker Compose, the backend and the frontend.
load_dotenv(ENV_FILE)

DEFAULT_GATEWAY_PORT = 3000
DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"


@dataclass(frozen=True)
class Settings:
    gateway_url: str
    gateway_token: str
    agent_name: str
    stt: str
    tts: str
    language: str
    greeting: str
    groq_base_url: str

    @classmethod
    def from_env(cls) -> Settings:
        # No fallback: an empty token would send an empty bearer and fail at the gateway.
        gateway_token = os.getenv("VOICE_GATEWAY_TOKEN", "")
        if not gateway_token.strip():
            raise RuntimeError(
                f"VOICE_GATEWAY_TOKEN is empty; set it in {ENV_FILE} to the gateway's voice token."
            )
        default_gateway = f"http://{os.getenv('IP_ADDRESS', '127.0.0.1')}:{DEFAULT_GATEWAY_PORT}"
        return cls(
            gateway_url=os.getenv("GATEWAY_URL", default_gateway).rstrip("/"),
            gateway_token=gateway_token,
            agent_name=os.getenv("LIVEKIT_AGENT_NAME", "assistant"),
            stt=os.getenv("VOICE_STT", "groq/whisper-large-v3-turbo"),
            tts=os.getenv("VOICE_TTS", "deepgram/flux-hannah-en"),
            language=os.getenv("VOICE_LANGUAGE", "en"),
            greeting=os.getenv("VOICE_GREETING", "Hi, I'm listening."),
            groq_base_url=os.getenv("GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL).rstrip("/"),
        )

    def conversation_base_url(self, conversation_id: str) -> str:
        """OpenAI-compatible base URL of the gateway, scoped to one conversation."""
        return f"{self.gateway_url}/api/voice/conversations/{conversation_id}/v1"
