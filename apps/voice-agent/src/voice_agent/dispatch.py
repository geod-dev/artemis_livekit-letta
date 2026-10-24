"""Room dispatch metadata: which conversation a voice job belongs to, and its starting mode."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger("voice_agent")

# Copied from VOICE_DISPATCH_KEYS in packages/contracts/src/agent-server.ts (the gateway
# writes these keys). Change both together.
CONVERSATION_ID_KEY = "conversation_id"
CALL_MODE_KEY = "call_mode"


@dataclass(frozen=True)
class Dispatch:
    conversation_id: str | None
    mode: Literal["short", "long"]


def parse_dispatch(raw_metadata: str | None) -> Dispatch:
    """Parse a job's metadata JSON. The web app asks for "long"; anything else is "short".

    Metadata that is not a JSON object yields no conversation, so the job leaves.
    """
    try:
        metadata = json.loads(raw_metadata or "{}")
    except ValueError:
        logger.error("job metadata is not valid JSON; leaving")
        return Dispatch(conversation_id=None, mode="short")
    if not isinstance(metadata, dict):
        logger.error("job metadata is not a JSON object; leaving")
        return Dispatch(conversation_id=None, mode="short")
    mode: Literal["short", "long"] = "long" if metadata.get(CALL_MODE_KEY) == "long" else "short"
    return Dispatch(conversation_id=metadata.get(CONVERSATION_ID_KEY) or None, mode=mode)
