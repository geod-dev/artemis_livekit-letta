/**
 * Composition root for the gateway: builds the dependencies its modules receive.
 * The only vendor implementation the gateway uses is the local workspace
 * (`@artemis/workspace/filesystem`), and it is selected here alone. Modules
 * receive the `WorkspaceTransport` interface and the agent-server HTTP client.
 */
import type { WorkspaceTransport } from '@artemis/workspace';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import { mkdirSync } from 'node:fs';
import { AgentServerClient } from './agent-server/client';
import { AttachmentStore } from './assistant/attachments/attachment-store';
import type { AppConfig } from './assistant/config';

export interface GatewayDependencies {
  agentServer: AgentServerClient;
  workspace: WorkspaceTransport;
  attachments: AttachmentStore;
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
    agentServer: new AgentServerClient(config.agentServer),
    workspace,
    attachments: new AttachmentStore(workspace),
  };
}
