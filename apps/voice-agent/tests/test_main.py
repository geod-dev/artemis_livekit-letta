"""Smoke test: the worker module loads with its settings and exposes its entry point."""

import importlib

import pytest


def test_main_module_loads_and_exposes_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "test-token")
    main = importlib.import_module("voice_agent.main")
    assert callable(main.run)
    assert main.settings.gateway_token == "test-token"
    assert main.logger.name == "voice_agent"
