# Models and speech providers

The main assistant uses anthropic/claude-haiku-5-5 with ANTHROPIC_API_KEY for text, voice, conversation naming, and memory reflection. ASSISTANT_MODEL selects its handle. Text offers Low, Medium, and High effort, defaulting to Medium, with adaptive thinking. Voice always uses medium effort with thinking disabled. Switching back to text restores adaptive thinking and the selected text effort.

## Workers

All delegated workers use openai-compatible/zai-org/GLM-5.3-Flash on Telnyx at provider effort high. ASSISTANT_TASK_MODEL configures the worker handle. Workers do not inherit the main assistant's model or text effort. The request adapter enforces high effort for this GLM handle.

Set OPENAI_COMPATIBLE_BASE_URL=https://api.telnyx.com/v2/ai/openai and OPENAI_COMPATIBLE_API_KEY to the Telnyx key. The Compose proxy maps Letta's /v1 paths onto Telnyx. This protocol connection requires no OpenAI account or credentials.

The Telnyx adapter preserves provider-reported limits and prices. Missing pricing uses neutral accounting rates with costKnown: false, and missing limits stay unknown. GLM image input is advertised explicitly.

## Claude compatibility

The pinned Letta Code 0.34.4 catalog predates Haiku 5.5. The Claude mod supplies its descriptor. A version-checked bundle patch independently applies thinking and output effort to Claude requests, removes unsupported sampling parameters, routes native workers to the configured worker model, and applies GLM high effort. Revalidate these adapters and outgoing-request tests before upgrading Letta.

## Speech

VOICE_STT=groq/whisper-large-v3-turbo transcribes voice calls through Groq using GROQ_API_KEY. The composer's microphone uses Groq as well. Voice uses local Silero voice activity detection and the local turn detector to segment audio for Groq's transcription endpoint.

VOICE_TTS=deepgram/flux-hannah-en generates speech using DEEPGRAM_API_KEY. Deepgram Aura voices are supported too. VOICE_LANGUAGE selects the transcription language. Voice and text turns share the same Letta conversation.

The LiveKit OpenAI plugin is retained only as a protocol client for Groq transcription and the backend's internal voice gateway. No OpenAI platform key is used.
