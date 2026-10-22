import { resolve } from 'node:path';
import { parseModelHandle } from '@artemis/llm';

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
    /** `ASSISTANT_PRESENT_TOOL`: the `present` tool is offered to new conversations (default off; `loadConfig` always sets it). */
    presentTool?: boolean;
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

const DEV_AGENT_SERVER_TOKEN = 'dev-agent-server-token-change-me';
/** Placeholder database passwords from `.env.example`; production refuses them. */
const DEV_DB_PASSWORDS = [
  'dev-postgres-password-change-me',
  'dev-artemis-db-password-change-me',
  'dev-hindsight-db-password-change-me',
];
const DEFAULT_ASSISTANT_MODEL = 'anthropic/claude-haiku-5-5';
const DEFAULT_TASK_MODEL = 'openai-compatible/zai-org/GLM-5.3-Flash';

/**
 * `WORKSPACE_RUN_AS=uid:gid`: agent commands run as this unprivileged user (Docker:
 * the `workspace` user, which can read but not write `data/`). Ignored on Windows.
 */
function parseRunAs(value: string | undefined): { uid: number; gid: number } | undefined {
  if (!value) return undefined;
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) throw new Error('WORKSPACE_RUN_AS must be "uid:gid" (numeric)');
  return { uid: Number(match[1]), gid: Number(match[2]) };
}

function text(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer of at least ${min}`);
  }
  return parsed;
}

/** The password embedded in a postgres URL, or undefined when absent or unparseable. */
function urlPassword(url: string): string | undefined {
  try {
    const { password } = new URL(url);
    return password ? decodeURIComponent(password) : undefined;
  } catch {
    return undefined;
  }
}

function modelHandle(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const handle = text(env, name) ?? fallback;
  parseModelHandle(handle);
  return handle;
}

/**
 * Reads and validates the agent-server environment. Throws on missing or
 * invalid values; production refuses the development token.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AgentServerConfig {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = text(env, 'DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const token = text(env, 'AGENT_SERVER_TOKEN') ?? DEV_AGENT_SERVER_TOKEN;
  if (production && token === DEV_AGENT_SERVER_TOKEN) {
    throw new Error('AGENT_SERVER_TOKEN must be explicitly set to a non-development secret in production');
  }
  if (production) {
    for (const [name, configured] of [
      ['DATABASE_URL password', urlPassword(databaseUrl)],
      ['ARTEMIS_DB_PASSWORD', text(env, 'ARTEMIS_DB_PASSWORD')],
      ['HINDSIGHT_DB_PASSWORD', text(env, 'HINDSIGHT_DB_PASSWORD')],
    ] as const) {
      if (configured !== undefined && DEV_DB_PASSWORDS.includes(configured)) {
        throw new Error(`${name} must be explicitly set to a non-development secret in production`);
      }
    }
  }

  const timezone = text(env, 'ASSISTANT_TIMEZONE') ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`ASSISTANT_TIMEZONE is not a valid IANA time zone: ${timezone}`);
  }

  const assistantModel = modelHandle(env, 'ASSISTANT_MODEL', DEFAULT_ASSISTANT_MODEL);
  const openAiBaseUrl = text(env, 'OPENAI_COMPATIBLE_BASE_URL');
  const openAiApiKey = text(env, 'OPENAI_COMPATIBLE_API_KEY');
  if (openAiBaseUrl && !openAiApiKey) {
    throw new Error('OPENAI_COMPATIBLE_API_KEY is required when OPENAI_COMPATIBLE_BASE_URL is set');
  }

  const hindsightUrl = text(env, 'HINDSIGHT_URL') ?? '';
  const workspaceRoot = resolve(text(env, 'WORKSPACE_PATH') ?? resolve(process.cwd(), '.workspace'));
  const runAs = parseRunAs(text(env, 'WORKSPACE_RUN_AS'));

  return {
    port: integer(env, 'AGENT_SERVER_PORT', 4000, 1),
    token,
    production,
    databaseUrl,
    assistant: {
      name: text(env, 'ASSISTANT_NAME') ?? 'Artemis',
      timezone,
      presentTool: text(env, 'ASSISTANT_PRESENT_TOOL') === 'true',
    },
    models: {
      assistant: assistantModel,
      task: modelHandle(env, 'ASSISTANT_TASK_MODEL', DEFAULT_TASK_MODEL),
      title: modelHandle(env, 'ASSISTANT_TITLE_MODEL', assistantModel),
    },
    providers: {
      anthropicApiKey: text(env, 'ANTHROPIC_API_KEY'),
      openAiCompatible:
        openAiBaseUrl && openAiApiKey ? { baseUrl: openAiBaseUrl, apiKey: openAiApiKey } : undefined,
    },
    workspace: {
      root: workspaceRoot,
      displayRoot: workspaceRoot,
      readOnlyPrefixes: ['data/'],
      ...(runAs ? { runAs } : {}),
    },
    workers: {
      idleTimeoutMs: integer(env, 'WORKER_IDLE_TIMEOUT_MS', 120_000, 1_000),
      backgroundAfterMs: integer(env, 'BASH_BACKGROUND_AFTER_MS', 10_000, 0),
      maxPendingTurns: 32,
      maxSubagents: 4,
    },
    memory: {
      enabled: hindsightUrl !== '',
      hindsightUrl,
      hindsightApiKey: text(env, 'HINDSIGHT_API_KEY'),
      bankId: text(env, 'HINDSIGHT_BANK_ID') ?? 'artemis',
      retainEvery: integer(env, 'MEMORY_RETAIN_EVERY', 3, 1),
      recallTimeoutMs: { voice: 1_500, text: 4_000 },
      recallMaxTokens: { low: 800, mid: 1_500, high: 3_000 },
    },
    mcp: {
      deviceBaseUrl: (text(env, 'MCP_DEVICE_BASE_URL') ?? 'http://backend:3000').replace(/\/$/, ''),
    },
  };
}
