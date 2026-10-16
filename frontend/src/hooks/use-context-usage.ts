import { useEffect, useState } from 'react';
import type { ConversationContextUsage } from '@shared/chat-types';
import { isRecord, requestJson } from '@/lib/api';

function isContextUsage(value: unknown): value is ConversationContextUsage | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.usedTokens === 'number' &&
      Number.isFinite(value.usedTokens) &&
      value.usedTokens >= 0 &&
      typeof value.windowTokens === 'number' &&
      Number.isFinite(value.windowTokens) &&
      value.windowTokens > 0 &&
      (value.model === null || typeof value.model === 'string') &&
      typeof value.reportedAt === 'string')
  );
}

/** Load retained usage, then refresh when the existing SSE feed reports a new snapshot. */
export function useContextUsage(id: string | null, revision: number) {
  const [snapshot, setSnapshot] = useState<{
    id: string;
    usage: ConversationContextUsage | null;
  } | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const usage = await requestJson(
          `/api/conversations/${encodeURIComponent(id)}/context-usage`,
          { signal: controller.signal, cache: 'no-store' },
          isContextUsage,
          'Could not load context usage'
        );
        if (!controller.signal.aborted) setSnapshot({ id, usage });
      } catch {
        // Keep the last reported value during transient connection failures.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    return () => {
      controller.abort();
    };
  }, [id, revision]);

  return id && snapshot?.id === id ? snapshot.usage : null;
}
