/**
 * Attachment policy of the gateway: where uploads live, how their names are made
 * safe, and the errors their routes answer with. The bytes themselves are
 * workspace files; the workspace is reached only through its interface.
 */
import { MAX_UPLOAD_BYTES } from './limits.ts';

/** Leading bytes that decide an upload's type; larger files are never read whole for it. */
export const SNIFF_BYTES = 8192;
/** The gateway's retention state, in its own state directory (not in the workspace). */
export const ATTACHMENT_RETENTION_FILE = 'attachment-retention.json';

/** Uploads live under this workspace directory; `data/` holds other gateway and agent-server subtrees. */
const ATTACHMENT_DIRECTORY = 'data/attachments';

/** `data/attachments/<uuid>/<name>`: the only paths an upload can have. */
export const ATTACHMENT_PATH =
  /^data\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/\\]+$/;

/** Workspace path of a new upload directory entry. */
export function attachmentPath(id: string, name: string): string {
  return `${ATTACHMENT_DIRECTORY}/${id}/${name}`;
}

/** A file name that is safe on disk and in a shell. */
export function safeName(name: string): string {
  const clean = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*`$]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return clean.slice(-120) || 'file';
}

/** The upload is larger than the limit. Routes answer 413 for this class only. */
export class PayloadTooLargeError extends Error {
  constructor(message = `Upload is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

/** An upload a turn names was removed before the turn was accepted. Routes answer 409 for this class. */
export class AttachmentUnavailableError extends Error {
  constructor() {
    super('attachment is no longer available');
    this.name = 'AttachmentUnavailableError';
  }
}

/** The upload or the turn names an attachment that cannot be used. Routes answer 400 for this class. */
export class InvalidAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttachmentError';
  }
}
