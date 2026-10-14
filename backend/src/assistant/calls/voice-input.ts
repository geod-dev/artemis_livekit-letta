/**
 * Extract new user speech from the OpenAI-style message list LiveKit sends.
 * Text is never an identity: saying the same words twice is valid input.
 */
const recentlyForwarded = new Map<string, Map<string, number>>();
const INPUT_TTL_MS = 30 * 60_000;
const MAX_IDENTITIES = 256;
const MAX_CONVERSATIONS = 128;

export function newVoiceInput(conversationId: string, messages: readonly unknown[], callId: string | null = null): string {
  const trailing: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | null;
    if (!m || m.role === 'system' || m.role === 'developer') continue;
    if (m.role !== 'user') break;
    const text = contentText(m.content).trim();
    const identity = messageId(m as { id?: unknown; clientMessageId?: unknown });
    if (text && !(identity && voiceInputAlreadyAccepted(conversationId, callId, identity))) trailing.unshift(text);
  }

  return trailing.join('\n');
}

/** Stable message identity for retries; absent IDs deliberately disable deduplication. */
export function voiceInputMessageId(messages: readonly unknown[]): string | null {
  const last = [...messages].reverse().find((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as { role?: unknown; content?: unknown };
    return row.role === 'user' && Boolean(contentText(row.content).trim());
  }) as { id?: unknown; clientMessageId?: unknown } | undefined;
  return messageId(last);
}

export function voiceInputMessageIds(messages: readonly unknown[]): string[] {
  const result: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as { role?: unknown; content?: unknown };
    if (row.role === 'system' || row.role === 'developer') continue;
    if (row.role !== 'user') break;
    if (!contentText(row.content).trim()) continue;
    const id = messageId(item as { id?: unknown; clientMessageId?: unknown });
    if (id) result.unshift(id);
  }
  return result;
}

function messageId(message: { id?: unknown; clientMessageId?: unknown } | undefined): string | null {
  const id = message?.clientMessageId ?? message?.id;
  return typeof id === 'string' && id.length <= 200 ? id : null;
}

export function voiceInputAlreadyAccepted(conversationId: string, callId: string | null, messageId: string | null): boolean {
  if (!callId || !messageId) return false;
  const key = `${callId}|${messageId}`;
  const seen = recentlyForwarded.get(conversationId);
  const timestamp = seen?.get(key);
  if (!timestamp) return false;
  if (Date.now() - timestamp > INPUT_TTL_MS) { seen?.delete(key); return false; }
  return true;
}

/** Call only after the scheduler accepted the turn. */
export function rememberVoiceInput(conversationId: string, callId: string | null, messageId: string | null): void {
  if (!callId || !messageId) return;
  const seen = recentlyForwarded.get(conversationId) ?? new Map<string, number>();
  const now = Date.now();
  for (const [key, time] of seen) if (now - time > INPUT_TTL_MS) seen.delete(key);
  seen.set(`${callId}|${messageId}`, now);
  while (seen.size > MAX_IDENTITIES) seen.delete(seen.keys().next().value!);
  if (!recentlyForwarded.has(conversationId) && recentlyForwarded.size >= MAX_CONVERSATIONS) {
    recentlyForwarded.delete(recentlyForwarded.keys().next().value!);
  }
  recentlyForwarded.set(conversationId, seen);
}

/** Release an admission reservation when the scheduler did not complete the turn. */
export function forgetVoiceInput(conversationId: string, callId: string | null, messageId: string): void {
  if (!callId) return;
  const seen = recentlyForwarded.get(conversationId);
  seen?.delete(`${callId}|${messageId}`);
  if (seen?.size === 0) recentlyForwarded.delete(conversationId);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
      .join(' ');
  }
  return '';
}
