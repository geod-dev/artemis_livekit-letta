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
from collections.abc import AsyncIterator, Callable, Coroutine
from typing import Any, Literal, TypeAlias

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
# Retry failed generations with a capped exponential delay while keeping the
# update claim retryable on the backend.
UPDATE_RETRY_BASE_SECONDS = 1.0
UPDATE_RETRY_MAX_SECONDS = 30.0

EventHandlerRegistration: TypeAlias = (
    tuple[Literal["speech_created"], Callable[[SpeechCreatedEvent], None]]
    | tuple[
        Literal["user_input_transcribed"],
        Callable[[UserInputTranscribedEvent], None],
    ]
    | tuple[Literal["user_state_changed"], Callable[[UserStateChangedEvent], None]]
)


class CallController:
    def __init__(self, ctx: JobContext, session: AgentSession, gateway: Gateway) -> None:
        self._ctx = ctx
        self._session = session
        self._gateway = gateway
        self._updates: deque[str] = deque()
        self._queued: set[str] = set()
        self._processing: set[str] = set()
        self._completed: set[str] = set()
        self._retry_scheduled: set[str] = set()
        self._retry_attempts: dict[str, int] = {}
        self._wake = asyncio.Event()
        self._end_task: asyncio.Task[None] | None = None
        self._ending = False
        self._tasks: set[asyncio.Task[None]] = set()
        self._handlers: list[EventHandlerRegistration] = []

    def start(self) -> None:
        registrations: list[EventHandlerRegistration] = [
            ("speech_created", self._on_speech_created),
            ("user_input_transcribed", self._on_user_input),
            ("user_state_changed", self._on_user_state),
        ]
        self._handlers.extend(registrations)
        for event, handler in self._handlers:
            self._session.on(event, handler)
        self._spawn(self._follow_gateway())
        self._spawn(self._speak_updates())

    async def aclose(self) -> None:
        self._ending = True
        for event, handler in self._handlers:
            off = getattr(self._session, "off", None)
            if off is not None:
                off(event, handler)
        self._handlers.clear()
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._end_task = None

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
            if self._end_task is not None and not self._end_task.done():
                self._end_task.cancel()
            self._end_task = self._spawn(self._end_after_grace())
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
                    if event.get("type") == "update" and isinstance(update_id, str):
                        self._queue_update(update_id)
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
                update_id = self._updates.popleft()
                self._queued.discard(update_id)
                self._processing.add(update_id)
                try:
                    completed = await self._speak_update(update_id)
                    if not completed:
                        self._schedule_update_retry(update_id)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._schedule_update_retry(update_id)
                    logger.exception("could not speak background update %s", update_id)
                finally:
                    self._processing.discard(update_id)

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

    async def _speak_update(self, update_id: str) -> bool:
        logger.info("speaking background update %s", update_id)
        streamed = False

        async def text() -> AsyncIterator[str]:
            nonlocal streamed
            async for chunk in self._gateway.update_text(update_id):
                yield chunk
            streamed = True

        handle = self._session.say(text(), add_to_chat_ctx=False)
        await handle.wait_for_playout()
        # Generation completion and hearing are different facts: a completed
        # stream is never regenerated, even when playback was interrupted.
        if streamed:
            self._completed.add(update_id)
            self._retry_attempts.pop(update_id, None)
        heard = streamed and not handle.interrupted
        with contextlib.suppress(Exception):
            await self._gateway.acknowledge_update(update_id, heard=heard)
        if heard:
            await self._after_response()
        return streamed

    def _queue_update(self, update_id: str) -> None:
        if (
            update_id in self._completed
            or update_id in self._queued
            or update_id in self._processing
            or update_id in self._retry_scheduled
        ):
            return
        self._updates.append(update_id)
        self._queued.add(update_id)
        self._wake.set()

    def _schedule_update_retry(self, update_id: str) -> None:
        if self._ending or update_id in self._completed or update_id in self._retry_scheduled:
            return
        attempt = self._retry_attempts.get(update_id, 0) + 1
        self._retry_attempts[update_id] = attempt
        delay = min(UPDATE_RETRY_BASE_SECONDS * (2 ** (attempt - 1)), UPDATE_RETRY_MAX_SECONDS)
        self._retry_scheduled.add(update_id)
        self._spawn(self._retry_update_after(update_id, delay))

    async def _retry_update_after(self, update_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        finally:
            self._retry_scheduled.discard(update_id)
        if not self._ending:
            self._queue_update(update_id)

    def _spawn(self, coro: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        try:
            task.result()
        except Exception:
            logger.exception("call lifecycle task failed")
