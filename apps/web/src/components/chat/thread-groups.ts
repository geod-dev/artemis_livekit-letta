/**
 * The conversation list's search and day grouping, as pure functions so the
 * grouping can be tested without rendering.
 */

export type ThreadListItemLike = { id: string; title?: string; lastMessageAt?: Date };

export type ThreadListGroup = { label: string; indices: number[] };

export const startOfLocalDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
  startOfYesterday: number
): string => {
  if (!date || date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfYesterday) return 'Yesterday';
  return 'Earlier';
};

/**
 * Filters the threads by title and buckets the matches by last activity
 * (Today, Yesterday, Earlier). `groups` is null when no thread carries a date
 * or the local day start is unknown, in which case `filteredIndices` keeps the
 * runtime order. Indices point into `threadIds`.
 */
export function groupThreadList(
  threadIds: readonly string[],
  items: readonly ThreadListItemLike[],
  searchQuery: string,
  startOfToday: number | undefined
): { filteredIndices: number[]; groups: ThreadListGroup[] | null } {
  const query = searchQuery.trim().toLowerCase();
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
  const filteredIndices = threadIds
    .map((id, index) => ({ id, index }))
    .filter(
      ({ id }) => !query || (itemsById.get(id)?.title || 'New Chat').toLowerCase().includes(query)
    )
    .map(({ index }) => index);
  if (startOfToday === undefined || !filteredIndices.some((index) => dates[index])) {
    return { filteredIndices, groups: null };
  }

  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const startOfYesterday = yesterday.getTime();
  const time = (index: number) => dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...filteredIndices].sort((a, b) => time(b) - time(a));

  const groups: ThreadListGroup[] = [];
  for (const index of sorted) {
    const label = dateGroupLabel(dates[index], startOfToday, startOfYesterday);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.label === label) {
      lastGroup.indices.push(index);
    } else {
      groups.push({ label, indices: [index] });
    }
  }
  return { filteredIndices, groups };
}
