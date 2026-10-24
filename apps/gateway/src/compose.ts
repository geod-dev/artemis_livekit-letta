/**
 * Composition root for the gateway: the only module that chooses vendor
 * implementations and builds the shared dependencies. The workspace is a local
 * directory (`@artemis/workspace/filesystem`), LiveKit and Groq sit behind the
 * interfaces in `src/vendor`, and device MCP endpoints are served through
 * `@artemis/mcp/device-server`. Modules receive these values; none reads a
 * module-level singleton.
 */
import type { WorkspaceTransport } from '@artemis/workspace';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import { mkdirSync } from 'node:fs';
import { AgentServerClient } from './agent-server/client.ts';
import { AttachmentStore } from './attachments/attachment-store.ts';
import type { AppConfig } from './config.ts';
import { DeviceHub } from './devices/hub.ts';
import type { LinkMetadata } from './link-preview/link-description.ts';
import { linkPreview } from './link-preview/link-preview.ts';
import type { TranscriptionPort } from './routes/transcription.ts';
import type { VoiceTokenPort } from './routes/voice.ts';
import { createGroqTranscriber } from './vendor/groq/transcription.ts';
import { createVoiceTokenIssuer } from './vendor/livekit/tokens.ts';

export interface GatewayDependencies {
  config: AppConfig;
  agentServer: AgentServerClient;
  workspace: WorkspaceTransport;
  attachments: AttachmentStore;
  deviceHub: DeviceHub;
  voiceTokens: VoiceTokenPort;
  transcriber: TranscriptionPort;
  /** Title and description of a public page; refuses private destinations. */
  linkPreview: (href: string) => Promise<LinkMetadata>;
}

/**
 * The workspace served from a local directory: the gateway's view of the shared
 * workspace root. The root is created when it is missing.
 */
export function composeWorkspace(root: string): WorkspaceTransport {
  mkdirSync(root, { recursive: true });
  return new FilesystemWorkspaceTransport({ root });
}

export function composeGateway(config: AppConfig): GatewayDependencies {
  const workspace = composeWorkspace(config.workspace.dir);
  return {
    config,
    agentServer: new AgentServerClient(config.agentServer),
    workspace,
    attachments: new AttachmentStore(workspace, config.workspace.dataDir),
    deviceHub: new DeviceHub({ baseUrl: () => config.deviceBaseUrl }),
    voiceTokens: createVoiceTokenIssuer(config.livekit),
    transcriber: createGroqTranscriber({
      apiKey: config.transcription.groqApiKey,
      model: config.transcription.model,
    }),
    linkPreview,
  };
}
