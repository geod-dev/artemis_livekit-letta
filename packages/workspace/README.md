# @artemis/workspace

The `WorkspaceTransport` abstraction for files and processes, with a local filesystem implementation.

- **Entry point:** `src/index.ts` exports the media-type helpers and the transport interface.
- **Vendor subpath** (composition roots only): `./filesystem` (`src/vendor/filesystem`), the local filesystem transport.
- **Tests:** the symlink tests skip on Windows without symlink privilege. Directory junctions still run.
- **Depends on:** `@artemis/core`.
- **Check:** `pnpm check:packages`.
