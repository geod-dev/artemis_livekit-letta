# Models and speech providers

The main assistant uses anthropic/claude-haiku-5-5 with ANTHROPIC_API_KEY for text, voice, conversation titles, and memory. ASSISTANT_MODEL selects its handle. Text turns use the selected effort (default Medium) with adaptive thinking. Voice always uses medium effort with thinking disabled.

## Workers

Delegated workers use openai-compatible/zai-org/GLM-5.3-Flash on Telnyx at provider effort high. ASSISTANT_TASK_MODEL configures the worker handle. Workers do not inherit the main assistant's model or text effort. The agent server calls Telnyx directly through the OpenAI-compatible provider; no proxy runs in Compose.

Set OPENAI_COMPATIBLE_BASE_URL=https://api.telnyx.com/v2/ai/openai and OPENAI_COMPATIBLE_API_KEY to the Telnyx key. This protocol connection requires no OpenAI account or credentials.

The Telnyx adapter preserves provider-reported limits and prices. Missing pricing uses neutral accounting rates with costKnown: false, and missing limits stay unknown. GLM image input is advertised explicitly.

## Model routing

The agent server selects the model and effort for each kind of request:

- Assistant text: ASSISTANT_MODEL with adaptive thinking and the turn's effort.
- Assistant voice: ASSISTANT_MODEL with thinking disabled and medium effort.
- Workers: ASSISTANT_TASK_MODEL at provider effort high.
- Titles: ASSISTANT_TITLE_MODEL, which falls back to ASSISTANT_MODEL, with thinking disabled and low effort.

Requests to Claude never send temperature, top_p, or top_k.

## Memory

Memory retention and recall use the Hindsight service. Hindsight's own LLM is claude-haiku-5-5 at effort medium, configured with ANTHROPIC_API_KEY through the Compose file.

## Speech

VOICE_STT=groq/whisper-large-v3-turbo transcribes voice calls through Groq using GROQ_API_KEY. The composer's microphone uses Groq as well. Voice uses local Silero voice activity detection and the local turn detector to segment audio for Groq's transcription endpoint.

VOICE_TTS=deepgram/flux-hannah-en generates speech using DEEPGRAM_API_KEY. Deepgram Aura voices are supported too. VOICE_LANGUAGE selects the transcription language. Voice and text turns share the same conversation.

The LiveKit OpenAI plugin is retained only as a protocol client for Groq transcription and the backend's internal voice gateway. No OpenAI platform key is used.
