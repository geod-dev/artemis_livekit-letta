"""LiveKit voice front-end for the persistent assistant.

This process only handles audio: speech-to-text, turn taking and text-to-speech.
The "brain" is the same assistant and conversation used by the text chat; it
is reached through the gateway's OpenAI-compatible endpoint, scoped to the
call's conversation. The gateway forwards each finished user turn into the
conversation and streams the reply back, so voice turns land in the chat
history like any other message.

A per-call control channel to the gateway (`call.py`) decides when the call
ends and speaks background updates; see `CallController`.
"""

from __future__ import annotations

import logging

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ChatMessage,
    ConversationItemAddedEvent,
    JobContext,
    cli,
    inference,
)
from livekit.plugins import openai

from .call import CallController
from .config import Settings, agent_name, load_env_file, require_provider_keys
from .dispatch import parse_dispatch
from .gateway import Gateway
from .speech import build_speech

logger = logging.getLogger("voice_agent")
# Importing this module has no side effects: the env file is read and the entrypoint is
# registered under its agent name in run().
server = AgentServer()


class VoiceFrontEnd(Agent):
    def __init__(self) -> None:
        # Instructions are not used by the gateway (the agent server owns the prompt and
        # memory); they only document intent for LiveKit tooling.
        super().__init__(instructions="Relay the user's speech to the assistant gateway.")


async def entrypoint(ctx: JobContext) -> None:
    dispatch = parse_dispatch(ctx.job.metadata)
    conversation_id = dispatch.conversation_id
    if not conversation_id:
        logger.error("job has no conversation_id in its metadata; leaving")
        return
    ctx.log_context_fields = {"room": ctx.room.name, "conversation": conversation_id}

    settings = Settings.from_env()
    speech = build_speech(
        settings.stt, settings.tts, settings.language, groq_base_url=settings.groq_base_url
    )
    session = AgentSession(
        stt=speech.stt,
        vad=inference.VAD(model="silero"),
        tts=speech.tts,
        llm=openai.LLM(
            model="artemis",
            base_url=settings.conversation_base_url(conversation_id),
            api_key=settings.gateway_token,
        ),
        turn_handling={
            "turn_detection": speech.turn_detection,
            # The gateway is stateful: a speculative request would be committed to
            # the conversation, so only send finished user turns.
            "preemptive_generation": {"enabled": False},
            "interruption": {"mode": "vad"},
        },
    )

    @session.on("conversation_item_added")
    def log_latency(event: ConversationItemAddedEvent) -> None:
        # Per-turn latency breakdown (end-of-turn, LLM first token, TTS first byte).
        item = event.item
        if isinstance(item, ChatMessage) and item.metrics:
            parts = [
                f"{k}={v * 1000:.0f}ms"
                for k, v in item.metrics.items()
                if isinstance(v, float) and k.endswith(("delay", "ttft", "ttfb", "latency"))
            ]
            if parts:
                logger.info("%s turn latency: %s", item.role, " ".join(parts))

    gateway = Gateway(settings.gateway_url, settings.gateway_token, conversation_id, dispatch.mode)
    call = CallController(ctx, session, gateway)

    async def on_shutdown() -> None:
        # Close the call on the gateway: undelivered updates go to the chat, and
        # the transcript goes to background memory consolidation.
        try:
            await call.aclose()
        finally:
            try:
                await gateway.call_ended()
            except Exception:
                logger.exception("failed to notify the gateway that the call ended")
            finally:
                await gateway.aclose()

    ctx.add_shutdown_callback(on_shutdown)

    await session.start(agent=VoiceFrontEnd(), room=ctx.room)
    await ctx.connect()
    call.start()
    if settings.greeting:
        session.say(settings.greeting, add_to_chat_ctx=False)


def run() -> None:
    # The env file is read first, so LIVEKIT_AGENT_NAME and the other settings in it apply.
    load_env_file()
    # Fail at boot, not on the first call, when the settings or the provider keys are invalid.
    settings = Settings.from_env()
    require_provider_keys(settings)
    server.rtc_session(agent_name=agent_name())(entrypoint)
    cli.run_app(server)


if __name__ == "__main__":
    run()
