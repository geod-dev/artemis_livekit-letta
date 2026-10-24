/**
 * Size limits shared by every route and module that accepts uploaded bytes. Kept
 * apart from the attachment policy so device files can use the limit without
 * depending on the attachment store.
 */
import { MAX_ATTACHMENT_BYTES } from '@artemis/contracts/chat-types';

/** The largest upload: a composer attachment, a voice recording or a device file. Defined once in contracts. */
export const MAX_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES;
