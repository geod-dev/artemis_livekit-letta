import type { ChatAttachment } from '@artemis/contracts/chat-types';
import { type WorkspaceTransport, imageType, inspectedMimeType } from '@artemis/workspace';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { describeWorkspaceFile } from '../workspace/describe.ts';
import {
  InvalidAttachmentError,
  PayloadTooLargeError,
  SNIFF_BYTES,
  attachmentPath,
  safeName,
} from './attachment-policy.ts';
import { AttachmentRegistry, type UploadRecord } from './attachment-registry.ts';
import { MAX_UPLOAD_BYTES } from './limits.ts';

/**
 * Uploads held in the workspace: stored under `data/attachments`, typed by their
 * leading bytes when they arrive, and kept while a conversation references them.
 */
export class AttachmentStore {
  /** Which conversations reference which uploads. */
  readonly registry: AttachmentRegistry;
  /**
   * Bridge for the conversation routes, which still call these names. FZ-06 moves
   * the routes to `registry` (reserveReferences, releaseReferences, setReferences);
   * delete this member with that change.
   */
  readonly conversations = {
    reserve: (conversationId: string, paths: readonly string[]) =>
      this.registry.reserveReferences(conversationId, paths),
    release: (conversationId: string) => this.registry.releaseReferences(conversationId),
    replace: (conversationId: string, paths: readonly string[]) =>
      this.registry.setReferences(conversationId, paths),
  };

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
    const upload: UploadRecord = {
      kind: imageType(head) ? 'image' : 'file',
      mimeType: inspectedMimeType(head),
    };
    const name = safeName(file.name);
    const path = attachmentPath(randomUUID(), name);
    await this.registry.register(path, upload);
    try {
      const writer = await this.workspace.openWrite(path);
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.commit(path);
      } catch (error) {
        await reader.cancel().catch(() => {});
        await writer.abort().catch(() => {});
        throw error;
      }
    } catch (error) {
      await this.registry.removeUnused(path).catch(() => {});
      throw error;
    }
    return { path, name, ...upload, size: file.size } satisfies ChatAttachment;
  }

  /**
   * Check the attachments of a turn against the registry and the workspace and
   * report their metadata. The type and kind recorded at upload time decide; the
   * file is not read again. An upload the registry does not know is refused.
   */
  async resolve(attachments: readonly ChatAttachment[]): Promise<ChatAttachment[]> {
    const resolved: ChatAttachment[] = [];
    for (const a of attachments) {
      const upload = await this.registry.uploadOf(a.path);
      const file = upload ? await describeWorkspaceFile(this.workspace, a.path) : null;
      if (!upload || !file) throw new InvalidAttachmentError(`Unknown attachment ${a.path}`);
      resolved.push({
        path: a.path,
        name: String(a.name || basename(a.path)).slice(0, 200),
        kind: upload.kind,
        mimeType: upload.mimeType,
        size: file.size,
      });
    }
    return resolved;
  }
}
