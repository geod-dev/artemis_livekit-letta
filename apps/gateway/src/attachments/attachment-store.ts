import { type WorkspaceTransport, imageType, inspectedMimeType } from '@artemis/workspace';
import type { ChatAttachment } from '@artemis/contracts/chat-types';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { describeWorkspaceFile } from '../workspace/files';
import {
  ATTACHMENT_PATH,
  InvalidAttachmentError,
  MAX_UPLOAD_BYTES,
  PayloadTooLargeError,
  SNIFF_BYTES,
  attachmentPath,
  safeName,
} from './attachment-policy';
import { AttachmentRegistry } from './attachment-registry';

/**
 * Uploads held in the workspace: stored under `data/attachments`, typed by their
 * leading bytes when they arrive, and kept while a conversation references them.
 */
export class AttachmentStore {
  /** Which conversations reference which uploads. */
  readonly registry: AttachmentRegistry;

  /** @param stateDirectory the gateway's data directory, where the retention state lives. */
  constructor(
    private readonly workspace: WorkspaceTransport,
    stateDirectory: string
  ) {
    this.registry = new AttachmentRegistry(workspace, stateDirectory);
  }

  /** Store an uploaded file in chunks, with its type sniffed from the first bytes. */
  async save(file: File): Promise<ChatAttachment> {
    if (file.size > MAX_UPLOAD_BYTES) throw new PayloadTooLargeError();
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    const mimeType = inspectedMimeType(head);
    const kind = imageType(head) ? 'image' : 'file';
    const name = safeName(file.name);
    const path = attachmentPath(randomUUID(), name);
    await this.registry.register(path, mimeType);
    try {
      const upload = await this.workspace.openWrite(path);
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await upload.write(value);
        }
        await upload.commit(path);
      } catch (error) {
        await reader.cancel().catch(() => {});
        await upload.abort().catch(() => {});
        throw error;
      }
    } catch (error) {
      await this.registry.removeUnused(path).catch(() => {});
      throw error;
    }
    return { path, name, kind, mimeType, size: file.size } satisfies ChatAttachment;
  }

  /**
   * Check the attachments of a turn against the workspace and report their
   * metadata. The type recorded at upload time decides; the file is not read again.
   */
  async resolve(attachments: readonly ChatAttachment[]): Promise<ChatAttachment[]> {
    const resolved: ChatAttachment[] = [];
    for (const a of attachments) {
      const file = ATTACHMENT_PATH.test(a.path)
        ? await describeWorkspaceFile(this.workspace, a.path)
        : null;
      if (!file) throw new InvalidAttachmentError(`Unknown attachment ${a.path}`);
      const mimeType = (await this.registry.mimeTypeOf(a.path)) ?? file.contentType;
      resolved.push({
        path: a.path,
        name: String(a.name || basename(a.path)).slice(0, 200),
        kind: mimeType.startsWith('image/') ? 'image' : 'file',
        mimeType,
        size: file.size,
      });
    }
    return resolved;
  }
}
