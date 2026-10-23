import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  port: number;
  agentServer: { url: string; token: string };
  workspace: { dir: string; dataDir: string };
  transcription: { groqApiKey?: string; model: string };
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string };
  voiceGatewayToken: string;
  auth: { password: string; deviceToken: string };
}

const DEV_AGENT_SERVER_TOKEN = 'dev-agent-server-token-change-me';
const backendDir = fileURLToPath(new URL('../../', import.meta.url));
// In the repository, backendDir is <repo>/backend. The container copies that
// package to /app, so its checkout root is /app rather than the filesystem root.
const repoDir = resolve(process.env.ARTEMIS_REPO_ROOT || resolve(backendDir, '..'));
// Host default, matching .env.example and the Compose mounts: <repo>/backend/.workspace.
const defaultWorkspace = join(repoDir, 'backend', '.workspace');
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
  const workspaceDir = workspaceValue ? resolve(workspaceValue) : defaultWorkspace;
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
    if (dataValue && canonicalPath(dataDir) === canonicalPath(defaultWorkspace))
      throw new Error('ASSISTANT_DATA_ROOT must not point at the default workspace root');
    if (
      workspaceValue &&
      dataValue &&
      (containsPath(workspaceDir, dataDir) || containsPath(dataDir, workspaceDir))
    ) {
      throw new Error(
        'WORKSPACE_PATH and ASSISTANT_DATA_ROOT must be separate, non-overlapping roots'
      );
    }
    const port = integer(env, 'BACKEND_PORT', 3000, 1);
    if (port > 65535) throw new Error('BACKEND_PORT must be between 1 and 65535');
    integer(env, 'AGENT_SERVER_PORT', 4000, 1);
    if (production) {
      for (const [name, fallback] of [
        ['ARTEMIS_PASSWORD', ''],
        ['ARTEMIS_DEVICE_TOKEN', ''],
        ['AGENT_SERVER_TOKEN', DEV_AGENT_SERVER_TOKEN],
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
  return {
    port: integer(env, 'BACKEND_PORT', 3000, 1),
    agentServer: {
      url: value(env, 'AGENT_SERVER_URL', `http://${ip}:${integer(env, 'AGENT_SERVER_PORT', 4000, 1)}`),
      token: value(env, 'AGENT_SERVER_TOKEN', DEV_AGENT_SERVER_TOKEN),
    },
    workspace: { dir: workspaceDir, dataDir },
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
