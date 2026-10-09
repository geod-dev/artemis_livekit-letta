import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One `.env` at the repo root is shared by Docker Compose, the backend, the
// frontend and the voice agent. Variables already set in the environment win.
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name} (see .env.example)`);
}

const workspaceDir = fileURLToPath(new URL('../../.workspace', import.meta.url));

/** Server-side configuration. Everything model/provider-specific lives here. */
export const config = {
  port: Number(process.env.BACKEND_PORT || 3000),
  letta: {
    url: env('LETTA_URL', 'http://127.0.0.1:4500'),
    token: process.env.LETTA_SERVER_TOKEN?.trim() || undefined,
    agentName: env('LETTA_AGENT_NAME', 'personal-assistant'),
  },
  assistant: {
    name: env('ASSISTANT_NAME', 'Ada'),
    timezone: env('ASSISTANT_TIMEZONE', 'Europe/Paris'),
  },
  /**
   * Two model tiers. `smart` answers text chat and does reflection; `fast` answers
   * voice turns and small side jobs (conversation titles). `reasoning` is a
   * reasoning tier ("low", ...) or '' for the model default.
   */
  models: {
    smart: {
      handle: env('ASSISTANT_SMART_MODEL', 'zai/glm-5.3'),
      reasoning: env('ASSISTANT_SMART_REASONING', ''),
    },
    fast: {
      handle: env('ASSISTANT_FAST_MODEL', 'cerebras/gpt-oss-120b'),
      reasoning: env('ASSISTANT_FAST_REASONING', 'low'),
    },
  },
  /**
   * The agent's workspace: `backend/.workspace` here, mounted as `agentDir` (its
   * working directory) in the Letta container (see docker-compose.yml). The
   * backend keeps its own files (attachments, state) in `dataDir`, which the
   * agent can read but not change.
   */
  workspace: {
    dir: workspaceDir,
    dataDir: join(workspaceDir, 'data'),
    agentDir: '/workspace',
  },
  memory: {
    /** Launch a background reflection (memory consolidation) every N agent steps. */
    reflectionStepCount: Number(process.env.ASSISTANT_REFLECTION_STEPS || 12),
  },
  /** Composer voice input: recordings are transcribed by Groq Whisper. */
  transcription: {
    groqApiKey: process.env.GROQ_API_KEY?.trim() || undefined,
    model: env('ASSISTANT_TRANSCRIPTION_MODEL', 'whisper-large-v3-turbo'),
  },
  livekit: {
    url: env('LIVEKIT_URL', 'ws://localhost:7880'),
    apiKey: env('LIVEKIT_API_KEY', 'devkey'),
    apiSecret: env('LIVEKIT_API_SECRET', 'secret'),
    agentName: env('LIVEKIT_AGENT_NAME', 'assistant'),
  },
  voiceGatewayToken: env('VOICE_GATEWAY_TOKEN', 'dev-voice-token-change-me'),
};

export type { Modality } from '../chat-types';
