"""Call lifecycle: ending a call after the last reply, and speaking background updates.

The gateway owns the interaction state (short or long conversation mode, and
whether the assistant's latest response needs the user's input). This module
owns the audio timing: it ends the call only once the final reply has finished
playing, and speaks queued background updates only once nobody is talking.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import AsyncIterator, Coroutine
from typing import Any

from livekit.agents import (
    AgentSession,
    JobContext,
    SpeechCreatedEvent,
    UserInputTranscribedEvent,
    UserStateChangedEvent,
)
from livekit.agents.voice import SpeechHandle

from .gateway import CallState, Gateway

logger = logging.getLogger("voice-agent")

# Pause between the end of a final reply and the hangup; speaking in it keeps the call.
END_GRACE_SECONDS = 0.6
# Silence required before a background update is spoken.
QUIET_SECONDS = 1.0
# Delay before reopening a dropped gateway channel.
RECONNECT_SECONDS = 2.0


class CallController:
    def __init__(self, ctx: JobContext, session: AgentSession, gateway: Gateway) -> None:
        self._ctx = ctx
        self._session = session
        self._gateway = gateway
        self._updates: deque[str] = deque()
        self._spoken: set[str] = set()
        self._wake = asyncio.Event()
        self._end_task: asyncio.Task[None] | None = None
        self._ending = False
        self._tasks: set[asyncio.Task[None]] = set()

    def start(self) -> None:
        self._session.on("speech_created", self._on_speech_created)
        self._session.on("user_input_transcribed", self._on_user_input)
        self._session.on("user_state_changed", self._on_user_state)
        self._spawn(self._follow_gateway())
        self._spawn(self._speak_updates())

    async def aclose(self) -> None:
        self._ending = True
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # -- Replies -------------------------------------------------------------

    def _on_speech_created(self, event: SpeechCreatedEvent) -> None:
        # Replies to user turns. Spoken updates are followed where they are said.
        if event.source == "generate_reply":
            self._spawn(self._after_reply(event.speech_handle))

    async def _after_reply(self, handle: SpeechHandle) -> None:
        await handle.wait_for_playout()
        if not handle.interrupted:
            await self._after_response()

    async def _after_response(self) -> None:
        state = await self._state()
        if state and state.next == "end":
            self._end_task = asyncio.create_task(self._end_after_grace())
        else:
            self._wake.set()

    async def _state(self) -> CallState | None:
        try:
            return await self._gateway.state()
        except Exception:
            logger.exception("could not read the call state; keeping the call open")
            return None

    def _on_user_input(self, _event: UserInputTranscribedEvent) -> None:
        if self._end_task and not self._end_task.done():
            logger.info("user spoke; keeping the call open")
            self._end_task.cancel()
            self._end_task = None

    def _on_user_state(self, event: UserStateChangedEvent) -> None:
        # A short call that waits for an answer nobody gives ends; a long one stays.
        if event.new_state == "away":
            self._spawn(self._end_if_short())

    async def _end_if_short(self) -> None:
        state = await self._state()
        if state and state.mode == "short" and self._session.user_state == "away":
            logger.info("user went away during a short call")
            await self.hang_up()

    async def _end_after_grace(self) -> None:
        await asyncio.sleep(END_GRACE_SECONDS)
        if self._session.user_state == "speaking" or self._session.current_speech is not None:
            return
        await self.hang_up()

    async def hang_up(self) -> None:
        """End the call for everyone (a session shutdown alone leaves the user connected)."""
        if self._ending:
            return
        self._ending = True
        logger.info("ending the call")
        # Close the session before the room so its final events still reach the room.
        await self._session.aclose()
        await self._ctx.delete_room()

    # -- Background updates --------------------------------------------------

    async def _follow_gateway(self) -> None:
        """Keep the gateway's call channel open; it delivers update notices."""
        while not self._ending:
            try:
                async for event in self._gateway.events():
                    update_id = event.get("id")
                    # A reopened channel announces pending updates again.
                    if (
                        event.get("type") == "update"
                        and isinstance(update_id, str)
                        and update_id not in self._updates
                        and update_id not in self._spoken
                    ):
                        self._updates.append(update_id)
                        self._wake.set()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("gateway call channel failed")
            if not self._ending:
                await asyncio.sleep(RECONNECT_SECONDS)

    async def _speak_updates(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self._updates and not self._ending:
                if not await self._quiet():
                    break
                await self._speak_update(self._updates.popleft())

    async def _quiet(self) -> bool:
        """Wait until neither the user nor the assistant is speaking or about to."""
        loop = asyncio.get_running_loop()
        quiet_since: float | None = None
        while not self._ending:
            idle = (
                self._session.user_state != "speaking"
                and self._session.agent_state == "listening"
                and self._session.current_speech is None
                and not (self._end_task and not self._end_task.done())
            )
            if not idle:
                quiet_since = None
            elif quiet_since is None:
                quiet_since = loop.time()
            elif loop.time() - quiet_since >= QUIET_SECONDS:
                return True
            await asyncio.sleep(0.1)
        return False

    async def _speak_update(self, update_id: str) -> None:
        logger.info("speaking background update %s", update_id)
        self._spoken.add(update_id)
        streamed = False

        async def text() -> AsyncIterator[str]:
            nonlocal streamed
            async for chunk in self._gateway.update_text(update_id):
                yield chunk
            streamed = True

        handle = self._session.say(text(), add_to_chat_ctx=False)
        await handle.wait_for_playout()
        # Heard only when the whole text was received and played without interruption.
        heard = streamed and not handle.interrupted
        with contextlib.suppress(Exception):
            await self._gateway.acknowledge_update(update_id, heard=heard)
        if heard:
            await self._after_response()

    def _spawn(self, coro: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
