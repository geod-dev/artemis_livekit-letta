/**
 * Composition root: the only module that imports vendor implementations
 * (`@artemis/llm/anthropic`, `@artemis/llm/openai-compatible`,
 * `@artemis/storage/postgres`, `@artemis/memory/hindsight`,
 * `@artemis/workspace/filesystem`, `@artemis/mcp/sdk`).
 *
 * Boot: loadConfig -> PostgresStorage.migrate -> supervisor.recover ->
 * MCP registry load + catalog refresh -> memory.ensureReady (non-blocking) ->
 * serve (Hono on AGENT_SERVER_PORT) -> reaper + memory outbox start.
 * SIGTERM: stop accepting, cancel turns, stop task workers (tasks end
 * `failed: interrupted`), flush memory outbox, close storage.
 */
import { notImplemented } from '@artemis/core';

export async function main(): Promise<void> {
  notImplemented('agent-server main');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.ts')) {
  main().catch((error: unknown) => {
    console.error('[agent-server] fatal', error);
    process.exit(1);
  });
}
