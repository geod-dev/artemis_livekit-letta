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
import { AgentServerClient } from './agent-server/client';
import { AttachmentStore } from './assistant/attachments/attachment-store';
import type { AppConfig } from './config';
import { DeviceHub } from './devices/hub';
import { createGroqTranscriber, type Transcriber } from './vendor/groq/transcription';
import { createVoiceTokenIssuer, type VoiceTokenIssuer } from './vendor/livekit/tokens';

export interface GatewayDependencies {
  config: AppConfig;
  agentServer: AgentServerClient;
  workspace: WorkspaceTransport;
  attachments: AttachmentStore;
  deviceHub: DeviceHub;
  voiceTokens: VoiceTokenIssuer;
  transcriber: Transcriber;
}

/**
 * The workspace served from a local directory: the gateway's view of the shared
 * workspace root. The root is created, as the gateway's first upload used to do.
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
    attachments: new AttachmentStore(workspace),
    deviceHub: new DeviceHub({ baseUrl: () => config.deviceBaseUrl }),
    voiceTokens: createVoiceTokenIssuer(config.livekit),
    transcriber: createGroqTranscriber({
      apiKey: config.transcription.groqApiKey,
      model: config.transcription.model,
    }),
  };
}
