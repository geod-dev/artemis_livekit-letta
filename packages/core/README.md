# @artemis/core

Shared primitives used by several packages: an injectable clock, `AppError` and its subclasses, `errorMessage`, id helpers, the image media-type list, the `isRecord` guard and a console logger.

- **Entry point:** `src/index.ts`.
- **Testing subpath:** `@artemis/core/testing` exports `FakeClock` (`src/testing.ts`).
- **Depends on:** no workspace package.
- **Check:** `pnpm check:packages`.
