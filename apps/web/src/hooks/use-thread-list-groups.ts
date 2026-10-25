import { useMemo, useSyncExternalStore } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { groupThreadList, startOfLocalDay } from '@/components/chat/thread-groups';

const subscribeToNextDay = (onDayChange: () => void) => {
  let timeout: number;
  const scheduleNextDay = () => {
    const now = new Date();
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    ).getTime();
    timeout = window.setTimeout(() => {
      onDayChange();
      scheduleNextDay();
    }, startOfTomorrow - now.getTime());
  };
  scheduleNextDay();
  return () => window.clearTimeout(timeout);
};

const getStartOfToday = () => startOfLocalDay(new Date());

// A server render and hydration see no day start, so a prerender never reads
// the clock; a client-only mount groups on its first render.
const getServerStartOfToday = () => undefined;

const useStartOfToday = () =>
  useSyncExternalStore<number | undefined>(
    subscribeToNextDay,
    getStartOfToday,
    getServerStartOfToday
  );

/**
 * The thread list's search and day groups (see groupThreadList).
 */
export const useThreadListGroups = (searchQuery = '') => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const startOfToday = useStartOfToday();

  return useMemo(
    () => ({ threadIds, ...groupThreadList(threadIds, threadItems, searchQuery, startOfToday) }),
    [threadIds, threadItems, searchQuery, startOfToday]
  );
};
