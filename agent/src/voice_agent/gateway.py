"""HTTP client for the backend's per-call control endpoints."""

from __future__ import annotations

import codecs
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

import aiohttp

HTTP_OPERATION_TIMEOUT_SECONDS = 10.0
EVENT_HEARTBEAT_TIMEOUT_SECONDS = 45.0


@dataclass(frozen=True)
class CallState:
    mode: Literal["short", "long"]
    next: Literal["end", "listen"]


class Gateway:
    """Control channel of one call. The conversation's text replies still flow
    through the OpenAI-compatible endpoint used as the session LLM."""

    def __init__(
        self,
        base_url: str,
        token: str,
        conversation_id: str,
        mode: Literal["short", "long"] = "short",
    ) -> None:
        self._url = f"{base_url}/api/voice/conversations/{conversation_id}"
        self._mode = mode
        self._headers = {"Authorization": f"Bearer {token}"}
        self._http = aiohttp.ClientSession(headers=self._headers)

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        """Open the call on the gateway and yield its events until the call closes.

        The gateway treats the call as active while this stream is open. A new
        call starts in the mode given at construction; a reopened channel keeps
        the call's current mode.
        """
        timeout = aiohttp.ClientTimeout(total=None, sock_read=EVENT_HEARTBEAT_TIMEOUT_SECONDS)
        async with self._http.get(
            f"{self._url}/call", params={"mode": self._mode}, timeout=timeout
        ) as response:
            response.raise_for_status()
            decoder = codecs.getincrementaldecoder("utf-8")()
            pending = ""
            async for raw in response.content:
                pending += decoder.decode(raw)
                while "\n" in pending:
                    line, pending = pending.split("\n", 1)
                    if line.endswith("\r"):
                        line = line[:-1]
                    if line.startswith("data:"):
                        yield json.loads(line[5:].strip())
            pending += decoder.decode(b"", final=True)
            if pending.endswith("\r"):
                pending = pending[:-1]
            if pending.startswith("data:"):
                yield json.loads(pending[5:].strip())

    async def state(self) -> CallState:
        """The call mode, and what the call does once the latest response has played."""
        timeout = aiohttp.ClientTimeout(total=HTTP_OPERATION_TIMEOUT_SECONDS)
        async with self._http.get(f"{self._url}/call/state", timeout=timeout) as response:
            response.raise_for_status()
            body = await response.json()
        return CallState(
            mode="long" if body.get("mode") == "long" else "short",
            next="end" if body.get("next") == "end" else "listen",
        )

    async def update_text(self, update_id: str) -> AsyncIterator[str]:
        """Stream the spoken text of a background update (runs its turn)."""
        decoder = codecs.getincrementaldecoder("utf-8")()
        async with self._http.post(f"{self._url}/call/updates/{update_id}") as response:
            response.raise_for_status()
            async for chunk in response.content.iter_any():
                if text := decoder.decode(chunk):
                    yield text
            if text := decoder.decode(b"", final=True):
                yield text

    async def acknowledge_update(self, update_id: str, *, heard: bool) -> None:
        timeout = aiohttp.ClientTimeout(total=HTTP_OPERATION_TIMEOUT_SECONDS)
        async with self._http.post(
            f"{self._url}/call/updates/{update_id}/ack",
            json={"heard": heard},
            timeout=timeout,
        ) as response:
            response.raise_for_status()

    async def call_ended(self) -> None:
        timeout = aiohttp.ClientTimeout(total=HTTP_OPERATION_TIMEOUT_SECONDS)
        async with self._http.post(f"{self._url}/ended", timeout=timeout) as response:
            response.raise_for_status()

    async def aclose(self) -> None:
        await self._http.close()
