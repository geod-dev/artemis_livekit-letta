# Models and voice providers

## Letta model handles

Model handles use `provider/model`. The fast model handles voice turns and small
side jobs; the smart model handles text turns and memory reflection. Configure
them with `ASSISTANT_FAST_MODEL`, `ASSISTANT_SMART_MODEL`, and their reasoning
settings in `.env`. `ASSISTANT_TASK_MODEL` optionally selects a model for the
research worker.

Native Letta providers use their provider API key. An optional OpenAI-compatible
provider is routed through the Compose proxy, which maps the `/v1` paths Letta
uses onto the configured upstream base URL.

## Telnyx

The Telnyx provider mod is enabled only when
`OPENAI_COMPATIBLE_BASE_URL` uses `api.telnyx.com`. Model IDs remain ordinary
`openai-compatible/<model-id>` handles. For GLM-5.3 and DeepSeek V4 Flash, the
adapter maps the reasoning levels documented by the provider and sends the
corresponding `reasoning_effort` values.

The Telnyx model list does not reliably state pricing, context size, output
limits, or image support. The adapter leaves missing limits unknown and only
advertises text input unless the endpoint supplies modality metadata. Letta's
internal response accounting requires a cost object: when prices are absent,
the adapter supplies neutral zero accounting rates with `costKnown: false`.
Those calculated costs are unavailable estimates, not evidence that a model is
free; only provider-supplied rates set `costKnown: true`. Review model
metadata and the provider's current terms before selecting a model for work with
specific context, modality, or cost needs.

The adapter and its outgoing request tests are tied to Letta Code 0.34.4 and the
pinned SDK used by this repository. A Letta upgrade requires revalidating the
adapter against the original published bundle before changing the pinned version.
See the pinned-bundle check in [Development](development.md).

## Voice

`VOICE_STT`, `VOICE_TTS`, and `VOICE_TTS_VOICE` select LiveKit-supported speech
providers. Provider keys are configured in `.env`. Deepgram Flux includes turn
detection; other STT providers use the local turn detector. The assistant speaks
completed user turns through the backend's streaming voice route, keeping voice
and text turns in the same Letta conversation.
