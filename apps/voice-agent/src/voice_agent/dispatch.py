"""Room dispatch metadata: which conversation a voice job belongs to, and its starting mode."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

# Copied from VOICE_DISPATCH_KEYS in packages/contracts/src/agent-server.ts (the gateway
# writes these keys). Change both together.
CONVERSATION_ID_KEY = "conversation_id"
CALL_MODE_KEY = "call_mode"


@dataclass(frozen=True)
class Dispatch:
    conversation_id: str | None
    mode: Literal["short", "long"]


def parse_dispatch(raw_metadata: str | None) -> Dispatch:
    """Parse a job's metadata JSON. The frontend asks for "long"; anything else is "short"."""
    metadata = json.loads(raw_metadata or "{}")
    mode: Literal["short", "long"] = "long" if metadata.get(CALL_MODE_KEY) == "long" else "short"
    return Dispatch(conversation_id=metadata.get(CONVERSATION_ID_KEY) or None, mode=mode)
