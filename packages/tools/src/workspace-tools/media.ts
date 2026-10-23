import { sniffMedia } from '@artemis/workspace';

/** A short human label for a binary file (e.g. `PDF document`); the workspace sniffer decides the type. */
export function describeBinary(bytes: Uint8Array): string {
  return sniffMedia(bytes).label;
}
