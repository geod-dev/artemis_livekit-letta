/**
 * Size limits shared by every route and module that accepts uploaded bytes. Kept
 * apart from the attachment policy so device files can use the limit without
 * depending on the attachment store.
 */

/** The largest upload: a composer attachment, a voice recording or a device file. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
