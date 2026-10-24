"""Configuration for the voice agent, read from a `.env` file and the process environment.

The env file defaults to the repo-root `.env` of a source checkout. Set `VOICE_ENV_FILE`
to read another file. The file is loaded only when it exists: a container gets its
settings from the environment that Compose passes in.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlsplit

from dotenv import load_dotenv

ENV_FILE_VARIABLE = "VOICE_ENV_FILE"
# apps/voice-agent/src/voice_agent/config.py -> the repository root (checkout only).
DEFAULT_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"

DEFAULT_AGENT_NAME = "assistant"
DEFAULT_GATEWAY_PORT = 3000
DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"


def env_file() -> Path:
    """The env file this process reads: `VOICE_ENV_FILE` when set, else the checkout's `.env`."""
    configured = os.getenv(ENV_FILE_VARIABLE, "").strip()
    return Path(configured) if configured else DEFAULT_ENV_FILE


def load_env_file() -> Path | None:
    """Load `env_file()` into the environment if it exists; return the path that was loaded."""
    path = env_file()
    if not path.is_file():
        return None
    load_dotenv(path)
    return path


def agent_name() -> str:
    return os.getenv("LIVEKIT_AGENT_NAME", DEFAULT_AGENT_NAME)


def _is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_service_name(host: str) -> bool:
    """A single DNS label, such as a Compose service name: not an IP address, no dots."""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return "." not in host
    return False


def require_secure_gateway_url(url: str) -> str:
    """Bearer tokens travel to the gateway, so a remote gateway must use HTTPS.

    Plain HTTP is accepted for loopback hosts and for single-label service names
    (Compose). Mirrors the device client's rule.
    """
    parts = urlsplit(url)
    host = parts.hostname
    if parts.scheme not in ("http", "https") or not host:
        raise ValueError(f"GATEWAY_URL must be an http(s) URL with a host, got {url!r}")
    if parts.scheme == "https" or _is_loopback_host(host) or _is_service_name(host):
        return url
    raise ValueError(
        f"GATEWAY_URL {url!r} uses plain HTTP for a remote host; use HTTPS "
        "(HTTP is allowed only for loopback hosts and Compose service names)."
    )


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
                f"VOICE_GATEWAY_TOKEN is empty; set it in {env_file()} "
                "to the gateway's voice token."
            )
        default_gateway = f"http://{os.getenv('IP_ADDRESS', '127.0.0.1')}:{DEFAULT_GATEWAY_PORT}"
        gateway_url = require_secure_gateway_url(
            os.getenv("GATEWAY_URL", default_gateway).rstrip("/")
        )
        return cls(
            gateway_url=gateway_url,
            gateway_token=gateway_token,
            agent_name=agent_name(),
            stt=os.getenv("VOICE_STT", "groq/whisper-large-v3-turbo"),
            tts=os.getenv("VOICE_TTS", "deepgram/flux-hannah-en"),
            language=os.getenv("VOICE_LANGUAGE", "en"),
            greeting=os.getenv("VOICE_GREETING", "Hi, I'm listening."),
            groq_base_url=os.getenv("GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL).rstrip("/"),
        )

    def conversation_base_url(self, conversation_id: str) -> str:
        """OpenAI-compatible base URL of the gateway, scoped to one conversation."""
        return f"{self.gateway_url}/api/voice/conversations/{quote(conversation_id, safe='')}/v1"
