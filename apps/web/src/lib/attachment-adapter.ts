import { CHAT_HTTP } from '@artemis/contracts/chat-http';
import { type ChatAttachment, MAX_TURN_ATTACHMENTS } from '@artemis/contracts/chat-types';
import type { AttachmentAdapter, CompleteAttachment } from '@assistant-ui/react';
import { apiFetch } from '@/lib/api';
import { MAX_ATTACHMENT_BYTES } from './attachments';
import { toThreadAttachment } from './thread-messages';

/**
 * Composer attachments (picker, drag and drop, paste): any file, uploaded to
 * the agent's workspace when the message is sent. The picker button hides at
 * the turn cap; `attached` reports how many attachments the composer holds, and
 * the adapter refuses a file past MAX_TURN_ATTACHMENTS whichever way it arrives.
 */
export function createAttachmentAdapter(attached: () => number): AttachmentAdapter {
  /** Files whose add has started but whose attachment is not in the composer yet. */
  let reserved = 0;
  return {
    accept: '*',
    async *add({ file }) {
      // Checked and counted in one synchronous step, so files added in one burst
      // (a multi-file drop) cannot all pass the check before the first one lands.
      if (attached() + reserved >= MAX_TURN_ATTACHMENTS)
        throw new Error(`A message takes at most ${MAX_TURN_ATTACHMENTS} attachments`);
      reserved += 1;
      try {
        if (file.size > MAX_ATTACHMENT_BYTES)
          throw new Error(`${file.name} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
        yield {
          id: crypto.randomUUID(),
          type: file.type.startsWith('image/') ? 'image' : 'file',
          name: file.name,
          contentType: file.type,
          file,
          status: { type: 'requires-action', reason: 'composer-send' },
        };
      } finally {
        // Resumes after the composer stored the attachment, so it is counted there now.
        reserved -= 1;
      }
    },
    async send(attachment, options) {
      const form = new FormData();
      form.append('file', attachment.file);
      const res = await apiFetch(CHAT_HTTP.attachments, {
        method: 'POST',
        body: form,
        signal: options?.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Could not upload ${attachment.name}`);
      return toThreadAttachment(body as ChatAttachment) as CompleteAttachment;
    },
    async remove(attachment) {
      if (!attachment.id.startsWith('data/attachments/')) return;
      await apiFetch(`${CHAT_HTTP.attachments}?path=${encodeURIComponent(attachment.id)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {});
    },
  };
}

/** The uploaded attachments of a sent message. */
export function sentAttachments(attachments: readonly CompleteAttachment[] = []): ChatAttachment[] {
  return attachments.map((a) => ({
    path: a.id,
    name: a.name,
    kind: a.type === 'image' ? 'image' : 'file',
    ...(a.contentType ? { mimeType: a.contentType } : {}),
  }));
}
