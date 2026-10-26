# @artemis/memory

The `MemoryStore` abstraction (retain and recall) with a recall budget, and the rendering of recalled memories into prompt text.

- **Entry point:** `src/index.ts` exports `MemoryStore` and its request and result types, the recall budget, and `renderRecalledMemories`.
- **Vendor subpath** (composition roots only): `./hindsight` (`src/vendor/hindsight`), the Hindsight implementation.
- **Testing subpath:** `./testing` (`src/testing.ts`).
- **Depends on:** `@vectorize-io/hindsight-client`.
- **Check:** `pnpm check:packages`.
