import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The gateway's runtime configuration: one value, built once by loadConfig and passed to compose. */
export interface AppConfig {
  port: number;
  /** Address the HTTP server binds to (GATEWAY_HOST; the Compose gateway service sets 0.0.0.0). */
  host: string;
  /** Base URL the agent-server uses to reach each device's MCP endpoint. */
  deviceBaseUrl: string;
  agentServer: { url: string; token: string };
  /**
   * `dir` is the shared workspace the agent reads and writes. `dataDir` is the
   * gateway-only state root (attachment retention state); the agent never sees it.
   */
  workspace: { dir: string; dataDir: string };
  transcription: { groqApiKey?: string; model: string };
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string };
  voiceGatewayToken: string;
  auth: { password: string; deviceToken: string };
}

const DEV_AGENT_SERVER_TOKEN = 'dev-agent-server-token-change-me';
const DEV_VOICE_GATEWAY_TOKEN = 'dev-voice-token-change-me';
const gatewayDir = fileURLToPath(new URL('../', import.meta.url));
// The apps/ folder holds source code only. Production runtime roots must resolve outside it.
const appsDir = resolve(gatewayDir, '..');
// The repository root, which owns the gitignored data/ folder and the shared .env.
const repoDir = resolve(gatewayDir, '..', '..');
// Development defaults, matching .env.example and the Compose mounts.
const defaultWorkspace = join(repoDir, 'data', 'workspace');
const defaultDataDir = join(repoDir, 'data', 'gateway');
let rootEnvLoaded = false;

function value(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production';
}

/** Empty, the development fallback, or a placeholder shipped in .env.example (change-me..., dev-...). */
function isPlaceholderSecret(configured: string | undefined, fallback: string): boolean {
  return (
    !configured ||
    configured === fallback ||
    configured.startsWith('change-me') ||
    configured.startsWith('dev-')
  );
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

/** Validate a supplied environment without loading files, for deployment checks and tests. */
export function validateConfig(env: NodeJS.ProcessEnv): AppConfig {
  const ip = value(env, 'IP_ADDRESS', '127.0.0.1');
  const production = isProduction(env);
  const workspaceValue = env.WORKSPACE_PATH?.trim();
  const workspaceDir = workspaceValue ? resolve(workspaceValue) : defaultWorkspace;
  const dataValue = env.ARTEMIS_DATA_DIR?.trim();
  const dataDir = dataValue ? resolve(dataValue) : defaultDataDir;
  if ((workspaceValue && !isAbsolute(workspaceValue)) || (dataValue && !isAbsolute(dataValue))) {
    throw new Error('WORKSPACE_PATH and ARTEMIS_DATA_DIR must be absolute paths');
  }
  if (production && (!workspaceValue || !dataValue))
    throw new Error('Production requires explicit WORKSPACE_PATH and ARTEMIS_DATA_DIR');
  if (production && [workspaceDir, dataDir].some((path) => containsPath(appsDir, path))) {
    throw new Error('Production WORKSPACE_PATH and ARTEMIS_DATA_DIR must not be inside apps/');
  }
  if (dataValue && canonicalPath(dataDir) === canonicalPath(defaultWorkspace))
    throw new Error('ARTEMIS_DATA_DIR must not point at the default workspace root');
  if (
    workspaceValue &&
    dataValue &&
    (containsPath(workspaceDir, dataDir) || containsPath(dataDir, workspaceDir))
  ) {
    throw new Error('WORKSPACE_PATH and ARTEMIS_DATA_DIR must be separate, non-overlapping roots');
  }
  const port = integer(env, 'GATEWAY_PORT', 3000, 1);
  if (port > 65535) throw new Error('GATEWAY_PORT must be between 1 and 65535');
  const agentServerPort = integer(env, 'AGENT_SERVER_PORT', 4000, 1);
  if (production) {
    for (const [name, fallback] of [
      ['ARTEMIS_PASSWORD', ''],
      ['ARTEMIS_DEVICE_TOKEN', ''],
      ['AGENT_SERVER_TOKEN', DEV_AGENT_SERVER_TOKEN],
      ['LIVEKIT_API_KEY', 'devkey'],
      ['LIVEKIT_API_SECRET', 'secret'],
      ['VOICE_GATEWAY_TOKEN', DEV_VOICE_GATEWAY_TOKEN],
    ] as const) {
      if (isPlaceholderSecret(env[name]?.trim(), fallback))
        throw new Error(`${name} must be set to a real secret in production, not a placeholder`);
    }
  }
  return {
    port,
    host: env.GATEWAY_HOST?.trim() || '127.0.0.1',
    deviceBaseUrl: (env.MCP_DEVICE_BASE_URL?.trim() || `http://127.0.0.1:${port}`).replace(
      /\/$/,
      ''
    ),
    agentServer: {
      url: value(env, 'AGENT_SERVER_URL', `http://${ip}:${agentServerPort}`),
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
    // No development fallback: loadConfig rejects an empty value in every mode.
    voiceGatewayToken: env.VOICE_GATEWAY_TOKEN?.trim() ?? '',
    auth: {
      password: env.ARTEMIS_PASSWORD?.trim() || '',
      deviceToken: env.ARTEMIS_DEVICE_TOKEN?.trim() || '',
    },
  };
}

/** Load the shared repository .env file and validate the complete runtime configuration. */
export function loadConfig(): AppConfig {
  if (!rootEnvLoaded) {
    const rootEnv = join(repoDir, '.env');
    if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
    rootEnvLoaded = true;
  }
  // Production secrets are checked by validateConfig; createAuth checks the login password.
  const config = validateConfig(process.env);
  if (!config.voiceGatewayToken)
    throw new Error('Set VOICE_GATEWAY_TOKEN in .env before starting the gateway');
  return config;
}
