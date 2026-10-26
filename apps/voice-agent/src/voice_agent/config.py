"""Configuration for the voice agent, read from a `.env` file and the process environment.

The env file defaults to the repo-root `.env` of a source checkout. Set `VOICE_ENV_FILE`
to read another file. The file is loaded only when it exists: a container gets its
settings from the environment that Compose passes in.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlsplit

from dotenv import load_dotenv

ENV_FILE_VARIABLE = "VOICE_ENV_FILE"

DEFAULT_AGENT_NAME = "assistant"
DEFAULT_GATEWAY_PORT = 3000
DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
PLACEHOLDER_TOKEN_PREFIX = "change-me"


def default_env_file(config_path: Path) -> Path | None:
    """The repo-root `.env` for a source checkout, or None for an installed package.

    `config_path` is this module's file, `apps/voice-agent/src/voice_agent/config.py`. A
    checkout has the app's `pyproject.toml` two levels above the package; an installed
    wheel in a virtualenv does not, so no `.env` is guessed from inside the environment.
    """
    resolved = config_path.resolve()
    app_dir = resolved.parents[2]
    if not (app_dir / "pyproject.toml").is_file():
        return None
    return resolved.parents[4] / ".env"


DEFAULT_ENV_FILE = default_env_file(Path(__file__))


def env_file() -> Path | None:
    """The env file this process reads: `VOICE_ENV_FILE` when set, else the checkout's `.env`."""
    configured = os.getenv(ENV_FILE_VARIABLE, "").strip()
    return Path(configured) if configured else DEFAULT_ENV_FILE


def load_env_file() -> Path | None:
    """Load `env_file()` into the environment if it exists; return the path that was loaded."""
    path = env_file()
    if path is None or not path.is_file():
        return None
    load_dotenv(path)
    return path


def agent_name() -> str:
    """The LiveKit dispatch name. An empty LIVEKIT_AGENT_NAME means the default."""
    return os.getenv("LIVEKIT_AGENT_NAME", "").strip() or DEFAULT_AGENT_NAME


def require_provider_keys(settings: Settings) -> None:
    """Fail at boot when a configured speech provider has no API key.

    The check names the variables only, so it reads the same in a container (where the
    settings come from the environment) and in a checkout.
    """
    missing: list[str] = []
    stt_provider = settings.stt.partition("/")[0].strip().lower()
    tts_provider = settings.tts.partition("/")[0].strip().lower()
    if stt_provider == "groq" and not os.getenv("GROQ_API_KEY", "").strip():
        missing.append("GROQ_API_KEY")
    if tts_provider == "deepgram" and not os.getenv("DEEPGRAM_API_KEY", "").strip():
        missing.append("DEEPGRAM_API_KEY")
    if missing:
        raise RuntimeError(
            f"{' and '.join(missing)} must be set for the configured speech providers "
            f"(VOICE_STT={settings.stt!r}, VOICE_TTS={settings.tts!r})."
        )


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


def require_secure_gateway_url(url: str, *, allow_service_name: bool = False) -> str:
    """Bearer tokens travel to the gateway, so a remote gateway must use HTTPS.

    Plain HTTP is accepted for loopback hosts. A single-label service name (a Compose
    service such as `gateway`) is accepted only when `allow_service_name` is set, because
    a bare name can resolve through a DNS search suffix to a remote host.
    """
    parts = urlsplit(url)
    host = parts.hostname
    if parts.scheme not in ("http", "https") or not host:
        raise ValueError(f"GATEWAY_URL must be an http(s) URL with a host, got {url!r}")
    if parts.scheme == "https" or _is_loopback_host(host):
        return url
    if allow_service_name and _is_service_name(host):
        return url
    raise ValueError(
        f"GATEWAY_URL {url!r} uses plain HTTP for a remote host; use HTTPS "
        "(HTTP is allowed only for loopback hosts, or for a Compose service name when "
        "GATEWAY_ALLOW_PLAIN_HTTP_SERVICE is set)."
    )


@dataclass(frozen=True)
class Settings:
    gateway_url: str
    # Kept out of repr so that logging or printing the settings never shows the bearer token.
    gateway_token: str = field(repr=False)
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
                "VOICE_GATEWAY_TOKEN is empty; set it to the gateway's voice token "
                "in the environment or the env file."
            )
        if gateway_token.strip().startswith(PLACEHOLDER_TOKEN_PREFIX):
            raise RuntimeError(
                "VOICE_GATEWAY_TOKEN is still a placeholder (it starts with "
                f"{PLACEHOLDER_TOKEN_PREFIX!r}); set it to the gateway's voice token."
            )
        default_gateway = f"http://{os.getenv('IP_ADDRESS', '127.0.0.1')}:{DEFAULT_GATEWAY_PORT}"
        allow_service_name = os.getenv("GATEWAY_ALLOW_PLAIN_HTTP_SERVICE", "").strip().lower() in {
            "1",
            "true",
            "yes",
        }
        gateway_url = require_secure_gateway_url(
            os.getenv("GATEWAY_URL", default_gateway).rstrip("/"),
            allow_service_name=allow_service_name,
        )
        return cls(
            gateway_url=gateway_url,
            gateway_token=gateway_token,
            stt=os.getenv("VOICE_STT", "groq/whisper-large-v3-turbo"),
            tts=os.getenv("VOICE_TTS", "deepgram/flux-hannah-en"),
            language=os.getenv("VOICE_LANGUAGE", "en"),
            greeting=os.getenv("VOICE_GREETING", "Hi, I'm listening."),
            groq_base_url=os.getenv("GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL).rstrip("/"),
        )

    def conversation_base_url(self, conversation_id: str) -> str:
        """OpenAI-compatible base URL of the gateway, scoped to one conversation."""
        return f"{self.gateway_url}/api/voice/conversations/{quote(conversation_id, safe='')}/v1"
