import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/chat-types';
import type { ActivityTask } from '@/components/chat/activity-context';
import type { TaskStatus } from '@/hooks/use-conversation';
import { runDuration, taskRuns } from '@/lib/agent-runs';

/** Durable task inventory, refreshed alongside live conversation events. */
export function useActivityTasks(
  id: string | null,
  running: TaskStatus[],
  messages: ChatMessage[]
) {
  const [inventory, setInventory] = useState<{ id: string; tasks: ActivityTask[] } | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const owner = useRef(id);
  const latestRequest = useRef(0);
  const starts = useRef(new Map<string, string>());
  const [now, setNow] = useState(Date.now);
  owner.current = id;
  const revision =
    running.map((t) => t.id).join('|') +
    messages
      .filter((m) => m.role === 'event')
      .map((m) => m.id)
      .join('|');
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
      const request = ++latestRequest.current;
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/tasks`, {
          signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const detail =
            body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
              ? body.error
              : `HTTP ${response.status}`;
          const requestId =
            body &&
            typeof body === 'object' &&
            'requestId' in body &&
            typeof body.requestId === 'string'
              ? ` (request ${body.requestId})`
              : '';
          throw new Error(`Could not load agent list: ${detail}${requestId}`);
        }
        const tasks: unknown = await response.json();
        if (
          !Array.isArray(tasks) ||
          !tasks.every(
            (t) =>
              t &&
              typeof t.id === 'string' &&
              typeof t.title === 'string' &&
              ['running', 'completed', 'failed', 'cancelled'].includes(t.status) &&
              (t.report === undefined || typeof t.report === 'string') &&
              (t.updateId === undefined || typeof t.updateId === 'string') &&
              (t.durationMs === undefined ||
                (typeof t.durationMs === 'number' &&
                  Number.isFinite(t.durationMs) &&
                  t.durationMs >= 0)) &&
              (t.kind === undefined || ['agent', 'command'].includes(t.kind))
          )
        )
          throw new Error('Could not load agent list: the server returned an unexpected response');
        if (owner.current === id && request === latestRequest.current && !signal?.aborted) {
          setInventory({ id, tasks });
          setFailure(null);
        }
      } catch (failure) {
        if (owner.current === id && !signal?.aborted)
          setFailure({
            id,
            message: failure instanceof Error ? failure.message : 'Could not load agent list',
          });
      }
    },
    [id]
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(controller.signal), 5000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh, revision]);

  const runs = useMemo(() => {
    const rows = inventory?.id === id ? inventory.tasks : [];
    const known = new Set(rows.map((t) => t.id));
    const live = running.filter((t) => !known.has(t.id));
    return taskRuns([...live, ...rows], messages).map((run) => {
      const key = `${id}:${run.id}`;
      if (!starts.current.has(key)) starts.current.set(key, new Date().toISOString());
      return { ...run, startedAt: run.startedAt ?? starts.current.get(key) };
    });
  }, [id, inventory, running, messages]);

  const hasRunning = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);
  const tasks = useMemo(
    () => runs.map((run) => ({ ...run, durationMs: runDuration(run, now) })),
    [runs, now]
  );

  const stopTask = useCallback(
    async (taskId: string) => {
      if (!id) return;
      const stopKey = `${id}:${taskId}`;
      setStopping((items) => new Set(items).add(stopKey));
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/cancel`,
          { method: 'POST' }
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || 'Could not stop the agent');
        }
        await refresh();
      } catch (failure) {
        if (owner.current === id)
          setFailure({
            id,
            message: failure instanceof Error ? failure.message : 'Could not stop the agent',
          });
      } finally {
        setStopping((items) => {
          const next = new Set(items);
          next.delete(stopKey);
          return next;
        });
      }
    },
    [id, refresh]
  );
  return {
    tasks,
    stopTask,
    stopping: new Set(
      [...stopping]
        .filter((key) => key.startsWith(`${id}:`))
        .map((key) => key.slice((id?.length ?? 0) + 1))
    ),
    error: failure?.id === id ? failure.message : null,
  };
}
