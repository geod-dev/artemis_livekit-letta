# @artemis/tools

The tool abstraction, the toolset registry, and the tool result and context types. It also holds the bash limits used by the bash tool.

- **Entry point:** `src/index.ts` exports the tool context, bash limits, result, tool and toolset modules.
- **Workspace tools subpath:** `./workspace-tools` (`src/workspace-tools/index.ts`), the default file and bash tools built on `@artemis/workspace`.
- **Depends on:** `@artemis/core`, `@artemis/contracts`, `@artemis/workspace`, `ajv`.
- **Check:** `pnpm check:packages`.
