# @artemis/storage

Domain records, repository interfaces, and the Postgres implementation with its SQL migrations.

Domain records use the shared contract vocabulary (`@artemis/contracts/chat-types`) on purpose, so storage and the API speak the same names.

- **Entry point:** `src/index.ts` exports the domain records and the `Storage` class with its `Repositories` type.
- **Vendor subpaths** (composition roots only): `./postgres` (`src/vendor/postgres`), `./postgres/testing`.
- **Testing subpath:** `./testing` (`src/vendor/ephemeral/ephemeral-storage.ts`), an in-memory store.
- **Migrations:** `migrations/`, applied in file order.
- **Integration tests** need `TEST_DATABASE_URL` set to a Postgres admin URL. Without it they are skipped with a warning. The suites create and drop their own databases.
- **Depends on:** `@artemis/core`, `@artemis/contracts`, `pg`.
- **Check:** `pnpm check:packages`.
