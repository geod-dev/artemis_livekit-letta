import type { AttachmentAdapter, CompleteAttachment } from '@assistant-ui/react';
import type { ChatAttachment } from '@backend/chat-types';
import { MAX_ATTACHMENT_BYTES } from './attachments';
import { toThreadAttachment } from './thread-messages';

/**
 * Composer attachments (picker, drag and drop, paste): any file, uploaded to
 * the agent's workspace when the message is sent.
 */
export const attachmentAdapter: AttachmentAdapter = {
  accept: '*',
  async add({ file }) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 25 MB`);
    return {
      id: crypto.randomUUID(),
      type: file.type.startsWith('image/') ? 'image' : 'file',
      name: file.name,
      contentType: file.type,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  },
  async send(attachment, options) {
    const form = new FormData();
    form.append('file', attachment.file);
    const res = await fetch('/api/attachments', {
      method: 'POST',
      body: form,
      signal: options?.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `Could not upload ${attachment.name}`);
    return toThreadAttachment(body as ChatAttachment) as CompleteAttachment;
  },
  async remove() {},
};

/** The uploaded attachments of a sent message. */
export function sentAttachments(attachments: readonly CompleteAttachment[] = []): ChatAttachment[] {
  return attachments.map((a) => ({
    path: a.id,
    name: a.name,
    kind: a.type === 'image' ? 'image' : 'file',
    ...(a.contentType ? { mimeType: a.contentType } : {}),
  }));
}
