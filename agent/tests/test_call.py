"""CallController against a fake session and gateway: when calls end, and how updates are spoken."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest

from voice_agent import call as call_module
from voice_agent.call import CallController
from voice_agent.gateway import CallState


class FakeHandle:
    def __init__(
        self, *, interrupted: bool = False, text: AsyncIterator[str] | None = None
    ) -> None:
        self.interrupted = interrupted
        self._text = text
        self.spoken = ""

    async def wait_for_playout(self) -> None:
        if self._text is not None:
            async for chunk in self._text:
                self.spoken += chunk


class FakeSession:
    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}
        self.user_state = "listening"
        self.agent_state = "listening"
        self.current_speech = None
        self.closed = False
        self.said: list[FakeHandle] = []
        self.interrupt_says = False

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    def emit(self, event: str, payload: Any) -> None:
        self.handlers[event](payload)

    def say(self, text: AsyncIterator[str], **_: Any) -> FakeHandle:
        handle = FakeHandle(interrupted=self.interrupt_says, text=text)
        self.said.append(handle)
        return handle

    async def aclose(self) -> None:
        self.closed = True


class FakeContext:
    def __init__(self) -> None:
        self.deleted = False

    async def delete_room(self) -> None:
        self.deleted = True


class FakeGateway:
    def __init__(self, state: CallState) -> None:
        self.call_state = state
        self.notices: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.acks: list[tuple[str, bool]] = []
        self.update_texts: dict[str, list[str]] = {}

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            yield await self.notices.get()

    async def state(self) -> CallState:
        return self.call_state

    async def update_text(self, update_id: str) -> AsyncIterator[str]:
        for chunk in self.update_texts.get(update_id, []):
            yield chunk

    async def acknowledge_update(self, update_id: str, *, heard: bool) -> None:
        self.acks.append((update_id, heard))


@pytest.fixture(autouse=True)
def fast_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(call_module, "END_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(call_module, "QUIET_SECONDS", 0.05)


def setup(state: CallState) -> tuple[CallController, FakeSession, FakeContext, FakeGateway]:
    session, ctx, gateway = FakeSession(), FakeContext(), FakeGateway(state)
    controller = CallController(ctx, session, gateway)  # type: ignore[arg-type]
    controller.start()
    return controller, session, ctx, gateway


def reply(session: FakeSession, *, interrupted: bool = False) -> None:
    handle = FakeHandle(interrupted=interrupted)
    session.emit("speech_created", SimpleNamespace(source="generate_reply", speech_handle=handle))


async def test_short_call_ends_after_a_final_reply_has_played() -> None:
    controller, session, ctx, _ = setup(CallState(mode="short", next="end"))
    reply(session)
    await asyncio.sleep(0.2)
    assert session.closed and ctx.deleted
    await controller.aclose()


async def test_reply_that_waits_for_the_user_keeps_the_call() -> None:
    controller, session, ctx, _ = setup(CallState(mode="short", next="listen"))
    reply(session)
    await asyncio.sleep(0.2)
    assert not ctx.deleted
    await controller.aclose()


async def test_interrupted_reply_never_ends_the_call() -> None:
    controller, session, ctx, _ = setup(CallState(mode="short", next="end"))
    reply(session, interrupted=True)
    await asyncio.sleep(0.2)
    assert not ctx.deleted
    await controller.aclose()


async def test_speaking_during_the_grace_period_keeps_the_call() -> None:
    controller, session, ctx, _ = setup(CallState(mode="short", next="end"))
    reply(session)
    await asyncio.sleep(0.01)
    session.emit("user_input_transcribed", SimpleNamespace())
    await asyncio.sleep(0.2)
    assert not ctx.deleted
    await controller.aclose()


async def test_away_user_ends_a_short_call_but_not_a_long_one() -> None:
    for mode, ends in (("short", True), ("long", False)):
        controller, session, ctx, _ = setup(CallState(mode=mode, next="listen"))
        session.user_state = "away"
        session.emit("user_state_changed", SimpleNamespace(new_state="away"))
        await asyncio.sleep(0.1)
        assert ctx.deleted is ends
        await controller.aclose()


async def test_update_is_spoken_when_quiet_and_acknowledged_as_heard() -> None:
    controller, session, ctx, gateway = setup(CallState(mode="long", next="listen"))
    gateway.update_texts["u1"] = ["Your flights ", "are booked."]
    session.user_state = "speaking"
    await gateway.notices.put({"type": "update", "id": "u1"})
    await asyncio.sleep(0.15)
    assert session.said == []  # waits while the user speaks
    session.user_state = "listening"
    await asyncio.sleep(0.3)
    assert [h.spoken for h in session.said] == ["Your flights are booked."]
    assert gateway.acks == [("u1", True)]
    await gateway.notices.put({"type": "update", "id": "u1"})  # announced again on reconnect
    await asyncio.sleep(0.2)
    assert len(session.said) == 1
    assert not ctx.deleted
    await controller.aclose()


async def test_interrupted_update_is_not_heard() -> None:
    controller, session, _, gateway = setup(CallState(mode="long", next="listen"))
    gateway.update_texts["u2"] = ["Heads up"]
    session.interrupt_says = True
    await gateway.notices.put({"type": "update", "id": "u2"})
    await asyncio.sleep(0.3)
    assert gateway.acks == [("u2", False)]
    await controller.aclose()
