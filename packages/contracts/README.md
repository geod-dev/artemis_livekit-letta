# @artemis/contracts

API contracts, tool names and the generated present-tool schemas shared by the web app, the gateway and the agent-server. This package has **no runtime dependencies**; it holds types, constants and validation that the apps import.

There is no root entry point. Consumers import the subpaths listed in `package.json`:

| Subpath | Source | Purpose |
| --- | --- | --- |
| `./chat-types` | `src/chat-types.ts` | Chat and conversation vocabulary, shared with storage. |
| `./chat-http` | `src/chat-http.ts` | Request and response shapes for the chat HTTP API. |
| `./tool-names` | `src/tool-names.ts` | Tool name constants. |
| `./tool-schemas` | `src/tool-schemas.ts` | Tool input schemas. |
| `./agent-server` | `src/agent-server.ts` | Agent-server API types. |
| `./present-validation` | `src/present-validation.ts` | Validation for the present tool (kept here, not in core, so the browser bundle can use it). |
| `./present-components` | `src/present-components.ts` | Component vocabulary for the present tool. |
| `./present-tool.json`, `./present-components.json` | `generated/` | Generated JSON schemas. Do not edit by hand. |

- **Rules:** no runtime dependencies, and no imports from `apps/` or other packages.
- **Check:** `pnpm check:packages`; `pnpm check:schema` checks the generated JSON.
