import { randomUUID } from 'node:crypto';
import type { ChatAttachment } from '@artemis/contracts/chat-types';
import type { ArtifactSink } from '@artemis/mcp';
import type { WorkspaceTransport } from '@artemis/workspace';

/** MCP results (images, files) are saved under `data/artifacts/<conversation>/`, read-only for agents. */
export function workspaceArtifactSink(workspace: WorkspaceTransport): ArtifactSink {
  return {
    async save({ conversationId, name, mimeType, bytes }) {
      const safeName = name.replace(/[^\w.-]+/g, '_') || 'artifact';
      const path = `data/artifacts/${conversationId}/${randomUUID()}-${safeName}`;
      await workspace.makeDirectory(`data/artifacts/${conversationId}`);
      await workspace.writeFile(path, bytes);
      const attachment: ChatAttachment = {
        path,
        name,
        kind: mimeType.startsWith('image/') ? 'image' : 'file',
        mimeType,
        size: bytes.byteLength,
      };
      return attachment;
    },
  };
}
