"""Smoke test: the worker module loads without settings and exposes its entry point."""

import importlib
import sys

import pytest


def test_main_module_loads_without_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    # Settings are validated in run() and in the entrypoint, not at import time.
    monkeypatch.delenv("VOICE_GATEWAY_TOKEN", raising=False)
    sys.modules.pop("voice_agent.main", None)
    main = importlib.import_module("voice_agent.main")
    assert callable(main.run)
    assert callable(main.entrypoint)
    assert main.logger.name == "voice_agent"


def test_run_rejects_missing_settings_before_starting_the_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VOICE_GATEWAY_TOKEN", raising=False)
    sys.modules.pop("voice_agent.main", None)
    main = importlib.import_module("voice_agent.main")
    started: list[bool] = []
    monkeypatch.setattr(main.cli, "run_app", lambda _server: started.append(True))
    with pytest.raises(RuntimeError, match="VOICE_GATEWAY_TOKEN is empty"):
        main.run()
    assert started == []
