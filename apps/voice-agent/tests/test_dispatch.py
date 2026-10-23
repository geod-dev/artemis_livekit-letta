import json

import pytest

from voice_agent.dispatch import CALL_MODE_KEY, CONVERSATION_ID_KEY, parse_dispatch


def test_conversation_and_long_mode_are_read_from_metadata():
    raw = json.dumps({CONVERSATION_ID_KEY: "c1", CALL_MODE_KEY: "long"})
    dispatch = parse_dispatch(raw)
    assert dispatch.conversation_id == "c1"
    assert dispatch.mode == "long"


@pytest.mark.parametrize("raw", [None, "", "{}", json.dumps({CALL_MODE_KEY: "fast"})])
def test_missing_conversation_or_unknown_mode_fall_back(raw):
    dispatch = parse_dispatch(raw)
    assert dispatch.conversation_id is None
    assert dispatch.mode == "short"


def test_dispatch_keys_match_the_contract_names():
    # The gateway writes these keys (VOICE_DISPATCH_KEYS in packages/contracts/src/agent-server.ts).
    assert CONVERSATION_ID_KEY == "conversation_id"
    assert CALL_MODE_KEY == "call_mode"
