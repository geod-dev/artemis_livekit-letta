# @artemis/llm

The LLM provider abstraction (`LlmProvider`) with an Anthropic implementation and an OpenAI-compatible implementation, plus a router that picks a provider per request.

- **Entry point:** `src/index.ts` re-exports `provider.ts`, `router.ts` and `types.ts`.
- **Vendor subpaths** (composition roots only, not for other packages): `./anthropic` (`src/vendor/anthropic`) and `./openai-compatible` (`src/vendor/openai-compatible`).
- **Testing subpath:** `./testing` (`src/testing/index.ts`).
- **Depends on:** `@artemis/core`, `@anthropic-ai/sdk`, `openai`.
- **Check:** `pnpm check:packages`.
