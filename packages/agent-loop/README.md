# @artemis/agent-loop

Provider-agnostic agent loop: stream a model step, run the tool calls it asks for, and repeat until the answer is final.

- **Entry point:** `src/index.ts` re-exports `loop.ts` (the streaming loop) and `one-shot.ts` (a single model call without tool iteration).
- **Depends on:** `@artemis/core`, `@artemis/llm`, `@artemis/tools`.
- **Rules:** no imports from `apps/`. Provider code is injected through `@artemis/llm`, never imported here.
- **Check:** `pnpm check:packages` (typecheck and tests for every package).
