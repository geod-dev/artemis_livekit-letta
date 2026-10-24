import { AttachmentUnavailableError } from './attachment-policy.ts';
import type { AttachmentRegistry } from './attachment-registry.ts';

/**
 * The reference bookkeeping between conversations and their uploads. Routes call
 * this service; it decides when an upload is kept and when it may be collected.
 */
export class ConversationAttachments {
  constructor(private readonly registry: AttachmentRegistry) {}

  /**
   * Reserves the uploads of a turn before the agent-server sees the turn. Fails
   * with AttachmentUnavailableError when one of them is already gone, and keeps
   * nothing from a refused reservation. The returned function gives back the
   * references this turn added; the route calls it when the turn is not accepted.
   */
  async reserve(conversationId: string, paths: readonly string[]): Promise<() => Promise<void>> {
    const { missing, added } = await this.registry.addReferences(conversationId, paths);
    if (missing.length > 0) {
      await this.registry.removeReferences(conversationId, added);
      throw new AttachmentUnavailableError();
    }
    return () => this.registry.removeReferences(conversationId, added);
  }

  /** A conversation was deleted: its uploads become collectable. */
  release(conversationId: string): Promise<void> {
    return this.registry.releaseReferences(conversationId);
  }

  /** A message was deleted: the conversation keeps the uploads its remaining messages show. */
  replace(conversationId: string, paths: readonly string[]): Promise<void> {
    return this.registry.setReferences(conversationId, paths);
  }
}
