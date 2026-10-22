import { notImplemented } from '@artemis/core';

/** Validated agent-server configuration (env, see architecture.md#environment-variables). */
export interface AgentServerConfig {
  port: number;
  /** Bearer token the gateway presents (`AGENT_SERVER_TOKEN`). */
  token: string;
  production: boolean;
  databaseUrl: string;
  assistant: {
    name: string;
    timezone: string;
  };
  models: {
    /** `ASSISTANT_MODEL`, e.g. `anthropic/claude-haiku-5-5`. */
    assistant: string;
    /** `ASSISTANT_TASK_MODEL`, e.g. `openai-compatible/zai-org/GLM-5.3-Flash`. */
    task: string;
    /** `ASSISTANT_TITLE_MODEL` (default: assistant model). */
    title: string;
  };
  providers: {
    anthropicApiKey?: string;
    openAiCompatible?: { baseUrl: string; apiKey: string };
  };
  workspace: {
    /** Host/container path of the workspace root (`WORKSPACE_PATH`, `/workspace` in Docker). */
    root: string;
    /** Path shown to the model (`/workspace`). */
    displayRoot: string;
    /** Prefixes agents may not write (`data/`). */
    readOnlyPrefixes: string[];
    /** Run agent commands as this user (Docker: the `workspace` user). */
    runAs?: { uid: number; gid: number };
  };
  workers: {
    /** Main agent worker idle lifetime (`WORKER_IDLE_TIMEOUT_MS`, default 120 000). */
    idleTimeoutMs: number;
    /** Foreground bash -> background (`BASH_BACKGROUND_AFTER_MS`, default 10 000). */
    backgroundAfterMs: number;
    maxPendingTurns: number;
    /** Max concurrently running subagent tasks (default 4). */
    maxSubagents: number;
  };
  memory: {
    enabled: boolean;
    hindsightUrl: string;
    hindsightApiKey?: string;
    bankId: string;
    /** User turns per retain batch (`MEMORY_RETAIN_EVERY`, default 3). */
    retainEvery: number;
    recallTimeoutMs: { voice: number; text: number };
    recallMaxTokens: { low: number; mid: number; high: number };
  };
  mcp: {
    /** Where device MCP endpoints live (`MCP_DEVICE_BASE_URL`, gateway). */
    deviceBaseUrl: string;
  };
}

export function loadConfig(_env: NodeJS.ProcessEnv): AgentServerConfig {
  return notImplemented('loadConfig');
}
