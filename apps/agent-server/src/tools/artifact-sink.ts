import { uuid } from '@artemis/core';
import type { ChatAttachment } from '@artemis/contracts/chat-types';
import type { ArtifactSink } from '@artemis/mcp';
import type { WorkspaceTransport } from '@artemis/workspace';
import { DATA_SUBDIRS } from '../config.ts';

/** MCP results (images, files) are saved under `DATA_SUBDIRS.artifacts/<conversation>/`, read-only for agents. */
export function workspaceArtifactSink(workspace: WorkspaceTransport): ArtifactSink {
  return {
    async save({ conversationId, name, mimeType, bytes }) {
      const safeName = name.replace(/[^\w.-]+/g, '_') || 'artifact';
      const directory = `${DATA_SUBDIRS.artifacts}/${conversationId}`;
      const path = `${directory}/${uuid()}-${safeName}`;
      await workspace.makeDirectory(directory);
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
