import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  port: number;
  letta: { url: string; token?: string; agentName: string; defaultConversationId?: string };
  assistant: { name: string; timezone: string };
  models: {
    smart: { handle: string; reasoning: string };
    fast: { handle: string; reasoning: string };
  };
  workspace: { dir: string; dataDir: string; agentDir: string };
  memory: { reflectionStepCount: number };
  transcription: { groqApiKey?: string; model: string };
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string };
  voiceGatewayToken: string;
  auth: { password: string; deviceToken: string };
}

const backendDir = fileURLToPath(new URL('../../', import.meta.url));
// In the repository, backendDir is <repo>/backend. The container copies that
// package to /app, so its checkout root is /app rather than the filesystem root.
const repoDir = resolve(process.env.ARTEMIS_REPO_ROOT || resolve(backendDir, '..'));
const legacyWorkspace = join(backendDir, '.workspace');
let loaded = false;
let rootEnvLoaded = false;

function value(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return (env[name]?.trim() || fallback).replaceAll('${IP_ADDRESS}', env.IP_ADDRESS || '127.0.0.1');
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min)
    throw new Error(`${name} must be an integer of at least ${min}`);
  return parsed;
}

function containsPath(parent: string, candidate: string): boolean {
  const child = relative(canonicalPath(parent), canonicalPath(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Canonicalize existing ancestors so symlinked roots and not-yet-created dirs compare safely. */
function canonicalPath(path: string): string {
  let probe = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    suffix.unshift(basename(probe));
    probe = parent;
  }
  let canonical = realpathSync.native(probe);
  for (const segment of suffix) canonical = resolve(canonical, segment);
  return canonical;
}

function makeConfig(env: NodeJS.ProcessEnv, strict: boolean): AppConfig {
  const ip = value(env, 'IP_ADDRESS', '127.0.0.1');
  const production = env.NODE_ENV === 'production';
  const workspaceValue = env.WORKSPACE_PATH?.trim();
  const workspaceDir = workspaceValue ? resolve(workspaceValue) : legacyWorkspace;
  const dataValue = env.ASSISTANT_DATA_ROOT?.trim();
  const dataDir = dataValue ? resolve(dataValue) : join(workspaceDir, 'data');
  if (strict) {
    if ((workspaceValue && !isAbsolute(workspaceValue)) || (dataValue && !isAbsolute(dataValue))) {
      throw new Error('WORKSPACE_PATH and ASSISTANT_DATA_ROOT must be absolute paths');
    }
    if (!isAbsolute(workspaceDir) || !isAbsolute(dataDir))
      throw new Error('WORKSPACE_PATH and ASSISTANT_DATA_ROOT must be absolute paths');
    if (production && (!workspaceValue || !dataValue))
      throw new Error(
        'Production requires explicit WORKSPACE_PATH and ASSISTANT_DATA_ROOT outside the checkout'
      );
    if (production && [workspaceDir, dataDir].some((path) => containsPath(repoDir, path))) {
      throw new Error(
        'Production workspace and data roots must be outside the repository checkout'
      );
    }
    if (dataValue && containsPath(repoDir, dataDir)) {
      throw new Error('ASSISTANT_DATA_ROOT must be outside the repository checkout');
    }
    if (dataValue && canonicalPath(dataDir) === canonicalPath(legacyWorkspace))
      throw new Error('ASSISTANT_DATA_ROOT must not point at the legacy workspace root');
    if (
      workspaceValue &&
      dataValue &&
      (containsPath(workspaceDir, dataDir) || containsPath(dataDir, workspaceDir))
    ) {
      throw new Error(
        'WORKSPACE_PATH and ASSISTANT_DATA_ROOT must be separate, non-overlapping roots'
      );
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: value(env, 'ASSISTANT_TIMEZONE', 'Europe/Paris') });
    } catch {
      throw new Error('ASSISTANT_TIMEZONE must be a valid IANA timezone');
    }
    const port = integer(env, 'BACKEND_PORT', 3000, 1);
    if (port > 65535) throw new Error('BACKEND_PORT must be between 1 and 65535');
    integer(env, 'ASSISTANT_REFLECTION_STEPS', 12, 1);
    if (production) {
      for (const [name, fallback] of [
        ['ARTEMIS_PASSWORD', ''],
        ['ARTEMIS_DEVICE_TOKEN', ''],
        ['LETTA_SERVER_TOKEN', 'dev-letta-token-change-me'],
        ['LIVEKIT_API_KEY', 'devkey'],
        ['LIVEKIT_API_SECRET', 'secret'],
        ['VOICE_GATEWAY_TOKEN', 'dev-voice-token-change-me'],
      ] as const) {
        const configured = env[name]?.trim();
        if (!configured || configured === fallback)
          throw new Error(
            `${name} must be explicitly set to a non-development secret in production`
          );
      }
    }
  }
  if (!workspaceValue && strict)
    console.warn(
      `[config] using legacy workspace at ${legacyWorkspace}; set WORKSPACE_PATH to move it explicitly`
    );
  if (!dataValue && strict)
    console.warn(
      `[config] using legacy data at ${join(workspaceDir, 'data')}; set ASSISTANT_DATA_ROOT to migrate explicitly`
    );
  return {
    port: integer(env, 'BACKEND_PORT', 3000, 1),
    letta: {
      url: value(env, 'LETTA_URL', `http://${ip}:4500`),
      token: env.LETTA_SERVER_TOKEN?.trim() || undefined,
      agentName: value(env, 'LETTA_AGENT_NAME', 'personal-assistant'),
      defaultConversationId: env.LETTA_DEFAULT_CONVERSATION_ID?.trim() || undefined,
    },
    assistant: {
      name: value(env, 'ASSISTANT_NAME', 'Ada'),
      timezone: value(env, 'ASSISTANT_TIMEZONE', 'Europe/Paris'),
    },
    models: {
      smart: {
        handle: value(env, 'ASSISTANT_SMART_MODEL', 'zai/glm-5.3'),
        reasoning: value(env, 'ASSISTANT_SMART_REASONING', ''),
      },
      fast: {
        handle: value(env, 'ASSISTANT_FAST_MODEL', 'cerebras/gpt-oss-120b'),
        reasoning: value(env, 'ASSISTANT_FAST_REASONING', 'none'),
      },
    },
    workspace: { dir: workspaceDir, dataDir, agentDir: '/workspace' },
    memory: { reflectionStepCount: integer(env, 'ASSISTANT_REFLECTION_STEPS', 12, 1) },
    transcription: {
      groqApiKey: env.GROQ_API_KEY?.trim() || undefined,
      model: value(env, 'ASSISTANT_TRANSCRIPTION_MODEL', 'whisper-large-v3-turbo'),
    },
    livekit: {
      url: value(env, 'LIVEKIT_URL', `ws://${ip}:7880`),
      apiKey: value(env, 'LIVEKIT_API_KEY', 'devkey'),
      apiSecret: value(env, 'LIVEKIT_API_SECRET', 'secret'),
      agentName: value(env, 'LIVEKIT_AGENT_NAME', 'assistant'),
    },
    voiceGatewayToken: value(env, 'VOICE_GATEWAY_TOKEN', 'dev-voice-token-change-me'),
    auth: {
      password: env.ARTEMIS_PASSWORD?.trim() || '',
      deviceToken: env.ARTEMIS_DEVICE_TOKEN?.trim() || '',
    },
  };
}

// Safe development defaults let modules and focused unit tests be imported without starting the app.
export let config: AppConfig = makeConfig(process.env, false);

/** Validate a supplied environment without loading files, for deployment checks and tests. */
export function validateConfig(environment: NodeJS.ProcessEnv): AppConfig {
  return makeConfig(environment, true);
}

/** Load the shared repository .env file and validate the complete runtime configuration once. */
export function loadConfig(): AppConfig {
  if (loaded) return config;
  if (!rootEnvLoaded) {
    const rootEnv = join(repoDir, '.env');
    if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
    rootEnvLoaded = true;
  }
  config = validateConfig(process.env);
  if (!config.auth.password)
    throw new Error('Set ARTEMIS_PASSWORD in .env before starting the backend');
  if (process.env.NODE_ENV === 'production' && !config.auth.deviceToken)
    throw new Error('Set ARTEMIS_DEVICE_TOKEN in production');
  loaded = true;
  return config;
}

export type { Modality } from '../chat-types';
