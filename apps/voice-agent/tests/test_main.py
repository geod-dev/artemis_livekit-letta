"""Smoke test: the worker module loads without settings and exposes its entry point."""

import importlib
import os
import sys
from pathlib import Path

import pytest
from livekit.agents import AgentServer


def test_main_module_loads_without_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    # Settings are validated in run() and in the entrypoint, not at import time.
    monkeypatch.delenv("VOICE_GATEWAY_TOKEN", raising=False)
    sys.modules.pop("voice_agent.main", None)
    main = importlib.import_module("voice_agent.main")
    assert callable(main.run)
    assert callable(main.entrypoint)
    assert main.logger.name == "voice_agent"


def test_import_does_not_read_the_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    env = tmp_path / "voice.env"
    env.write_text("VOICE_LANGUAGE=de\n", encoding="utf-8")
    monkeypatch.setenv("VOICE_ENV_FILE", str(env))
    monkeypatch.delenv("VOICE_LANGUAGE", raising=False)
    sys.modules.pop("voice_agent.main", None)
    importlib.import_module("voice_agent.main")
    assert "VOICE_LANGUAGE" not in os.environ


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


def test_run_rejects_missing_provider_key_before_starting_the_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOICE_GATEWAY_TOKEN", "test-token")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    sys.modules.pop("voice_agent.main", None)
    main = importlib.import_module("voice_agent.main")
    started: list[bool] = []
    monkeypatch.setattr(main.cli, "run_app", lambda _server: started.append(True))
    with pytest.raises(RuntimeError, match="GROQ_API_KEY must be set"):
        main.run()
    assert started == []


def test_run_reads_the_env_file_and_registers_the_entrypoint_under_its_agent_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    env = tmp_path / "voice.env"
    env.write_text(
        "VOICE_GATEWAY_TOKEN=test-token\n"
        "GROQ_API_KEY=groq\n"
        "DEEPGRAM_API_KEY=dg\n"
        "LIVEKIT_AGENT_NAME=night-desk\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("VOICE_ENV_FILE", str(env))
    for name in (
        "VOICE_GATEWAY_TOKEN",
        "GROQ_API_KEY",
        "DEEPGRAM_API_KEY",
        "LIVEKIT_AGENT_NAME",
        "LIVEKIT_AGENT_NAME_OVERRIDE",
    ):
        # setenv then delenv: monkeypatch restores the original (absent) state at teardown,
        # because load_dotenv writes os.environ directly and would otherwise leak.
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)
    sys.modules.pop("voice_agent.main", None)
    main = importlib.import_module("voice_agent.main")
    # A fresh server, so the registration does not leak into other tests.
    server = AgentServer()
    monkeypatch.setattr(main, "server", server)
    started: list[bool] = []
    monkeypatch.setattr(main.cli, "run_app", lambda _server: started.append(True))
    main.run()
    assert started == [True]
    # LiveKit's AgentServer has no public getter for its registration (worker.py stores it
    # in these private attributes), so the test reads them.
    assert server._entrypoint_fnc is main.entrypoint
    assert server._agent_name == "night-desk"
