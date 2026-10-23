import type { Clock } from '@artemis/core';

/**
 * Voice input extraction (port of backend/src/assistant/calls/voice-input.ts).
 * LiveKit re-sends the whole conversation on every completion request, so the
 * new utterance is the trailing run of user messages. Text is never an
 * identity: saying the same words twice is valid input. Only LiveKit item ids
 * (`clientMessageId` or `id`) identify a message, and a ledger remembers the
 * ones already admitted per call so retries do not run twice.
 */

interface VoiceEntry {
  text: string;
  identity: string | null;
}

export interface VoiceUtterance {
  /** The new user words, joined by new lines. */
  text: string;
  /** Identity of the latest user message (idempotency key of the turn). */
  clientMessageId: string | null;
  /** Identities of every trailing user message, admitted or not. */
  identities: string[];
}

/** Trailing user messages that carry text, oldest first. System/developer rows are skipped. */
export function trailingUserEntries(messages: readonly unknown[]): VoiceEntry[] {
  const entries: VoiceEntry[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = asRow(messages[i]);
    if (!row || row.role === 'system' || row.role === 'developer') continue;
    if (row.role !== 'user') break;
    const text = contentText(row.content).trim();
    if (text) entries.unshift({ text, identity: identityOf(row) });
  }
  return entries;
}

/** Remembers admitted utterances per call for a while (retries of the same LiveKit item are dropped). */
export class VoiceInputLedger {
  private readonly seen = new Map<string, Map<string, number>>();
  private static readonly TTL_MS = 30 * 60_000;
  private static readonly MAX_IDENTITIES = 256;
  private static readonly MAX_CONVERSATIONS = 128;

  constructor(private readonly clock: Clock) {}

  accepted(conversationId: string, callId: string | null, identity: string | null): boolean {
    if (!callId || !identity) return false;
    const key = `${callId}|${identity}`;
    const seen = this.seen.get(conversationId);
    const at = seen?.get(key);
    if (at === undefined) return false;
    if (this.clock.now() - at > VoiceInputLedger.TTL_MS) {
      seen?.delete(key);
      return false;
    }
    return true;
  }

  /** Call only after the turn was accepted by the worker. */
  remember(conversationId: string, callId: string | null, identity: string | null): void {
    if (!callId || !identity) return;
    const now = this.clock.now();
    if (!this.seen.has(conversationId) && this.seen.size >= VoiceInputLedger.MAX_CONVERSATIONS) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    const seen = this.seen.get(conversationId) ?? new Map<string, number>();
    for (const [key, at] of seen) if (now - at > VoiceInputLedger.TTL_MS) seen.delete(key);
    seen.set(`${callId}|${identity}`, now);
    while (seen.size > VoiceInputLedger.MAX_IDENTITIES) seen.delete(seen.keys().next().value!);
    this.seen.set(conversationId, seen);
  }

  /** Releases an admission whose turn did not complete, so LiveKit may retry it. */
  forget(conversationId: string, callId: string | null, identity: string | null): void {
    if (!callId || !identity) return;
    const seen = this.seen.get(conversationId);
    seen?.delete(`${callId}|${identity}`);
    if (seen?.size === 0) this.seen.delete(conversationId);
  }
}

interface Row {
  role?: unknown;
  content?: unknown;
  id?: unknown;
  clientMessageId?: unknown;
}

function asRow(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function identityOf(row: Row): string | null {
  const id = row.clientMessageId ?? row.id;
  return typeof id === 'string' && id.length <= 200 ? id : null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join(' ');
  }
  return '';
}
