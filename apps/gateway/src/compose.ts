/**
 * Composition root for the gateway: the only module that chooses vendor
 * implementations and builds the shared dependencies. The workspace is a local
 * directory (`@artemis/workspace/filesystem`), LiveKit and Groq sit behind the
 * ports of `@artemis/voice-services`, and device MCP endpoints are served through
 * `@artemis/mcp/device-server`. Modules receive these values; none reads a
 * module-level singleton.
 */
import {
  handleDeviceMcpRequest,
  parseDeviceToolResult,
  parseDeviceTools,
} from '@artemis/mcp/device-server';
import { createGroqTranscriber } from '@artemis/voice-services/groq';
import { createVoiceTokenIssuer } from '@artemis/voice-services/livekit';
import type { WorkspaceTransport } from '@artemis/workspace';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import { mkdirSync } from 'node:fs';
import { AgentServerClient } from './agent-server/client.ts';
import { AttachmentStore } from './attachments/attachment-store.ts';
import type { AppConfig } from './config.ts';
import { DeviceHub, type DeviceProtocol } from './devices/hub.ts';
import { sweepDeviceFiles } from './devices/upload.ts';
import type { LinkMetadata } from './link-preview/link-description.ts';
import { linkPreview } from './link-preview/link-preview.ts';
import type { TranscriptionPort } from './routes/transcription.ts';
import type { VoiceTokenPort } from './routes/voice.ts';

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

/** The device MCP protocol, from the SDK-backed module; the device hub receives it here. */
export function composeDeviceProtocol(): DeviceProtocol {
  return {
    parseTools: parseDeviceTools,
    parseToolResult: parseDeviceToolResult,
    serve: handleDeviceMcpRequest,
  };
}

export function composeGateway(config: AppConfig): GatewayDependencies {
  const workspace = composeWorkspace(config.workspace.dir);
  // Boot sweep of device exports; each upload sweeps again. A failure is logged, not fatal.
  void sweepDeviceFiles(workspace).catch((error) =>
    console.error('[devices] sweeping old device exports failed', error)
  );
  return {
    config,
    agentServer: new AgentServerClient(config.agentServer),
    workspace,
    attachments: new AttachmentStore(workspace, config.workspace.dataDir),
    deviceHub: new DeviceHub({
      baseUrl: () => config.deviceBaseUrl,
      protocol: composeDeviceProtocol(),
    }),
    voiceTokens: createVoiceTokenIssuer(config.livekit),
    transcriber: createGroqTranscriber({
      apiKey: config.transcription.groqApiKey,
      model: config.transcription.model,
    }),
    linkPreview,
  };
}
