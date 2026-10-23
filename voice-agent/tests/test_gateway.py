"""Gateway HTTP lifecycle and streaming behavior."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from voice_agent import gateway as gateway_module
from voice_agent.gateway import Gateway


class FakeContent:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    def __aiter__(self) -> AsyncIterator[bytes]:
        async def iterate() -> AsyncIterator[bytes]:
            for chunk in self.chunks:
                yield chunk

        return iterate()

    async def iter_any(self) -> AsyncIterator[bytes]:
        async for chunk in self:
            yield chunk


class FakeResponse:
    def __init__(self, chunks: list[bytes] | None = None) -> None:
        self.content = FakeContent(chunks or [])

    async def __aenter__(self) -> FakeResponse:
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    async def json(self) -> dict[str, str]:
        return {"mode": "short", "next": "listen"}


class FakeHTTP:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append(("GET", url, kwargs))
        return self.response

    def post(self, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append(("POST", url, kwargs))
        return self.response


def make_gateway(
    monkeypatch: pytest.MonkeyPatch, response: FakeResponse
) -> tuple[Gateway, FakeHTTP]:
    http = FakeHTTP(response)
    monkeypatch.setattr(gateway_module.aiohttp, "ClientSession", lambda **_: http)
    return Gateway("https://gateway", "token", "conversation"), http


async def test_update_text_flushes_utf8_decoder_at_eof(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway, _ = make_gateway(monkeypatch, FakeResponse([b"hello ", b"\xe2", b"\x82\xac"]))
    chunks = [chunk async for chunk in gateway.update_text("u1")]
    assert "".join(chunks) == "hello €"


async def test_update_text_reports_incomplete_utf8_at_eof(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway, _ = make_gateway(monkeypatch, FakeResponse([b"hello \xe2"]))
    with pytest.raises(UnicodeDecodeError):
        _ = [chunk async for chunk in gateway.update_text("u1")]


async def test_event_stream_uses_a_heartbeat_read_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway, http = make_gateway(
        monkeypatch, FakeResponse([b'data: {"type":', b'"update","id":"u1"}\n'])
    )
    events = [event async for event in gateway.events()]
    timeout = http.calls[0][2]["timeout"]
    assert events == [{"type": "update", "id": "u1"}]
    assert timeout.total is None
    assert timeout.sock_read == gateway_module.EVENT_HEARTBEAT_TIMEOUT_SECONDS


async def test_state_ack_and_end_use_bounded_deadlines(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway, http = make_gateway(monkeypatch, FakeResponse())
    await gateway.state()
    await gateway.acknowledge_update("u1", heard=True)
    await gateway.call_ended()
    assert [call[2]["timeout"].total for call in http.calls] == [
        gateway_module.HTTP_OPERATION_TIMEOUT_SECONDS
    ] * 3
