/**
 * Attachment policy of the gateway: where uploads live, how large they may be,
 * and how their names are made safe. The bytes themselves are workspace files;
 * the workspace is reached only through its interface.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
/** Larger uploads are not read to sniff their type; their name and size decide. */
export const MAX_SNIFF_BYTES = 5 * 1024 * 1024;

/** Uploads live under this workspace directory; the agent-server owns everything else under `data/`. */
export const ATTACHMENT_DIRECTORY = 'data/attachments';

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
