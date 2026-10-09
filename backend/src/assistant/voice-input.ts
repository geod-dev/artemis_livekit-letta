/**
 * Extract the not-yet-forwarded user speech from the OpenAI-style message list
 * LiveKit sends. LiveKit keeps its own copy of the dialogue; the canonical
 * history is in Letta, so we forward only the trailing user messages and skip
 * any we already forwarded (e.g. when a reply was interrupted and LiveKit asks
 * again with the same context).
 */
const recentlyForwarded = new Map<string, string[]>();
const MEMORY = 8;

export function newVoiceInput(conversationId: string, messages: readonly unknown[]): string {
  const trailing: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | null;
    if (!m || m.role === 'system' || m.role === 'developer') continue;
    if (m.role !== 'user') break;
    const text = contentText(m.content).trim();
    if (text) trailing.unshift(text);
  }

  const seen = recentlyForwarded.get(conversationId) ?? [];
  const fresh = trailing.filter((t) => !seen.includes(t));
  if (fresh.length) recentlyForwarded.set(conversationId, [...seen, ...fresh].slice(-MEMORY));
  return fresh.join('\n');
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
