import { type WorkspaceTransport, imageType, inspectedMimeType } from '@artemis/workspace';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { ChatAttachment } from '../../chat-types';
import { describeWorkspaceFile } from '../workspace-files';
import {
  ATTACHMENT_PATH,
  MAX_ATTACHMENT_BYTES,
  MAX_SNIFF_BYTES,
  attachmentPath,
  safeName,
} from './attachment-policy';
import { AttachmentRegistry } from './attachment-registry';

/**
 * Uploads held in the workspace: stored under `data/attachments`, typed by their
 * bytes, and kept while a conversation references them.
 */
export class AttachmentStore {
  /** Which conversations reference which uploads. */
  readonly registry: AttachmentRegistry;

  constructor(private readonly workspace: WorkspaceTransport) {
    this.registry = new AttachmentRegistry(workspace);
  }

  /** Store an uploaded file, with metadata derived from its actual bytes. */
  async save(file: File): Promise<ChatAttachment> {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('File is larger than 25 MB');
    const bytes = Buffer.from(await file.arrayBuffer());
    const name = safeName(file.name);
    const path = attachmentPath(randomUUID(), name);
    await this.registry.register(path);
    try {
      await this.workspace.writeFile(path, bytes);
    } catch (error) {
      await this.registry.removeUnused(path).catch(() => {});
      throw error;
    }
    return {
      path,
      name,
      kind: imageType(bytes) ? 'image' : 'file',
      mimeType: inspectedMimeType(bytes),
      size: bytes.length,
    } satisfies ChatAttachment;
  }

  /** Check the attachments of a turn against the workspace and report their inspected metadata. */
  async resolve(attachments: readonly ChatAttachment[]): Promise<ChatAttachment[]> {
    const resolved: ChatAttachment[] = [];
    for (const a of attachments) {
      const file = ATTACHMENT_PATH.test(a.path)
        ? await describeWorkspaceFile(this.workspace, a.path)
        : null;
      if (!file) throw new Error(`Unknown attachment ${a.path}`);
      // Larger files are not read whole; their leading bytes decide, as `describeWorkspaceFile` does.
      const bytes = file.size <= MAX_SNIFF_BYTES ? await this.workspace.readFile(a.path) : null;
      const detected = bytes ? inspectedMimeType(bytes) : file.contentType;
      resolved.push({
        path: a.path,
        name: String(a.name || basename(a.path)).slice(0, 200),
        kind: detected.startsWith('image/') ? 'image' : 'file',
        mimeType: detected,
        size: file.size,
      });
    }
    return resolved;
  }
}
