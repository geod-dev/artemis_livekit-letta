import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelHandle } from '@artemis/llm';

/** Validated agent-server configuration (env, see the variable list in `.env.example`). */
export interface AgentServerConfig {
  port: number;
  /** Bearer token the gateway presents (`AGENT_SERVER_TOKEN`). */
  token: string;
  databaseUrl: string;
  assistant: {
    name: string;
    timezone: string;
    /** `ASSISTANT_PRESENT_TOOL`: the `present` tool is offered to new conversations (default off). */
    presentTool: boolean;
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
    /** Path shown to the model: always `/workspace`, also when the server runs on the host. */
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
    /** Fixed at 32 (not read from the environment). */
    maxPendingTurns: number;
    /** Max concurrently running subagent tasks, fixed at 4 (not read from the environment). */
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

/** Fixed limits and workspace settings: not read from the environment. */
export const MAX_PENDING_TURNS = 32;
const MAX_SUBAGENTS = 4;
/** Workspace-relative data area: written by the server, read-only for agent tools. */
export const DATA_DIR = 'data';
/** Subpaths of `DATA_DIR` (workspace-relative). */
export const DATA_SUBDIRS = { tasks: `${DATA_DIR}/tasks`, artifacts: `${DATA_DIR}/artifacts` } as const;
/** The workspace root as the model sees it, wherever the server runs. */
const DISPLAY_ROOT = '/workspace';
const READ_ONLY_PREFIXES = [`${DATA_DIR}/`];
const RECALL_TIMEOUT_MS = { voice: 1_500, text: 4_000 };
const RECALL_MAX_TOKENS = { low: 800, mid: 1_500, high: 3_000 };
/** Workspace file search: `rg` when it is on the PATH, otherwise a JavaScript walk. */
export const WORKSPACE_RIPGREP = 'auto' as const;

/**
 * `WORKSPACE_RUN_AS=uid:gid`: agent commands run as this unprivileged user. Target
 * (Docker, Coolify): uid 1002 for agent commands; `data/` is owned by the server uid
 * 1001 and is read-only to the agent. Ignored on Windows.
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

/** A model handle must name a provider that is configured; the error names the variable to set. */
function requireConfiguredProvider(name: string, handle: string, openAiCompatibleConfigured: boolean): void {
  const { provider } = parseModelHandle(handle);
  if (provider === 'anthropic') return;
  if (provider === 'openai-compatible') {
    if (!openAiCompatibleConfigured) {
      throw new Error(
        `${name} uses provider openai-compatible, which is not configured: set OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_API_KEY (or choose another ${name})`
      );
    }
    return;
  }
  throw new Error(`${name} uses unknown provider "${provider}" (expected anthropic or openai-compatible)`);
}

/**
 * Boot check: a model route that uses the anthropic provider needs `ANTHROPIC_API_KEY`, or
 * every turn on that route would fail at call time. Kept out of `loadConfig` so that
 * configuration can be read without a key; the entry point calls it once before it starts.
 */
export function assertAnthropicKeyForModels(config: Pick<AgentServerConfig, 'models' | 'providers'>): void {
  const names = Object.entries(config.models)
    .filter(([, handle]) => parseModelHandle(handle).provider === 'anthropic')
    .map(([role]) => role);
  if (names.length > 0 && !config.providers.anthropicApiKey) {
    throw new Error(`ANTHROPIC_API_KEY is required: these model roles use the anthropic provider: ${names.join(', ')}`);
  }
}

/**
 * Loads the repository-root `.env` for host runs (Docker passes it through `env_file`).
 * Variables already set in the process win over the file.
 */
export function loadRootEnv(): void {
  const file = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
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
  const openAiCompatible =
    openAiBaseUrl && openAiApiKey ? { baseUrl: openAiBaseUrl, apiKey: openAiApiKey } : undefined;

  const models = {
    assistant: assistantModel,
    task: modelHandle(env, 'ASSISTANT_TASK_MODEL', DEFAULT_TASK_MODEL),
    title: modelHandle(env, 'ASSISTANT_TITLE_MODEL', assistantModel),
  };
  requireConfiguredProvider('ASSISTANT_MODEL', models.assistant, openAiCompatible !== undefined);
  requireConfiguredProvider('ASSISTANT_TASK_MODEL', models.task, openAiCompatible !== undefined);
  requireConfiguredProvider('ASSISTANT_TITLE_MODEL', models.title, openAiCompatible !== undefined);

  const hindsightUrl = text(env, 'HINDSIGHT_URL') ?? '';
  const workspaceRoot = resolve(
    text(env, 'WORKSPACE_PATH') ?? fileURLToPath(new URL('../../../data/workspace', import.meta.url))
  );
  const runAs = parseRunAs(text(env, 'WORKSPACE_RUN_AS'));

  return {
    port: integer(env, 'AGENT_SERVER_PORT', 4000, 1),
    token,
    databaseUrl,
    assistant: {
      name: text(env, 'ASSISTANT_NAME') ?? 'Artemis',
      timezone,
      presentTool: text(env, 'ASSISTANT_PRESENT_TOOL') === 'true',
    },
    models,
    providers: {
      anthropicApiKey: text(env, 'ANTHROPIC_API_KEY'),
      openAiCompatible,
    },
    workspace: {
      root: workspaceRoot,
      displayRoot: DISPLAY_ROOT,
      readOnlyPrefixes: [...READ_ONLY_PREFIXES],
      ...(runAs ? { runAs } : {}),
    },
    workers: {
      idleTimeoutMs: integer(env, 'WORKER_IDLE_TIMEOUT_MS', 120_000, 1_000),
      backgroundAfterMs: integer(env, 'BASH_BACKGROUND_AFTER_MS', 10_000, 0),
      maxPendingTurns: MAX_PENDING_TURNS,
      maxSubagents: MAX_SUBAGENTS,
    },
    memory: {
      enabled: hindsightUrl !== '',
      hindsightUrl,
      hindsightApiKey: text(env, 'HINDSIGHT_API_KEY'),
      bankId: text(env, 'HINDSIGHT_BANK_ID') ?? 'artemis',
      retainEvery: integer(env, 'MEMORY_RETAIN_EVERY', 3, 1),
      recallTimeoutMs: { ...RECALL_TIMEOUT_MS },
      recallMaxTokens: { ...RECALL_MAX_TOKENS },
    },
  };
}
