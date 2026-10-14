import {
  type ComponentPropsWithoutRef,
  type FC,
  Fragment,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ArchiveIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react';
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/shadcn/utils';

export const ThreadList: FC = () => {
  const [search, setSearch] = useState('');
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot>
      <ThreadListNew />
      {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
      <ThreadListItems searchQuery={hasThreads ? search : ''} />
    </ThreadListRoot>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, 'value' | 'onChange'> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative px-0.5 py-1">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="Search threads"
        placeholder="Search threads"
        className={cn('h-8 ps-8 text-sm', className)}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = 'ThreadListSearch';

export const ThreadListRoot: FC<ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>> = ({
  className,
  ...props
}) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn('flex flex-col gap-0.5', className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<ComponentPropsWithoutRef<'div'> & { searchQuery?: string }> = ({
  className,
  searchQuery = '',
  ...props
}) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn('flex flex-col gap-0.5', className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
  startOfYesterday: number
): string => {
  if (!date || date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfYesterday) return 'Yesterday';
  return 'Earlier';
};

const startOfLocalDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

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

export type ThreadListGroup = { label: string; indices: number[] };

/**
 * Filters the thread list by title and buckets the matches by last activity
 * (Today, Yesterday, Earlier). `groups` is null when no thread carries a date
 * or while the local day start is unknown during server render and hydration,
 * in which case `filteredIndices` keeps the runtime order.
 */
export const useThreadListGroups = (searchQuery = '') => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const query = searchQuery.trim().toLowerCase();
  const startOfToday = useStartOfToday();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(
        ({ id }) => !query || (itemsById.get(id)?.title || 'New Chat').toLowerCase().includes(query)
      )
      .map(({ index }) => index);
    if (startOfToday === undefined || !filteredIndices.some((index) => dates[index])) {
      return { threadIds, filteredIndices, groups: null };
    }

    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = yesterday.getTime();
    const time = (index: number) => dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...filteredIndices].sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], startOfToday, startOfYesterday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, query, startOfToday]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const { threadIds, filteredIndices, groups } = useThreadListGroups(searchQuery);
  const query = searchQuery.trim();

  if (query && filteredIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-3 py-4 text-[13.5px]"
      >
        No threads found
      </div>
    );
  }

  if (!groups) {
    return filteredIndices.map((index) => (
      <ThreadListPrimitive.ItemByIndex
        key={threadIds[index]}
        index={index}
        components={{ ThreadListItem }}
      />
    ));
  }

  return groups.map((group) => (
    <Fragment key={group.label}>
      <div
        data-slot="aui_thread-list-group-label"
        className="text-muted-foreground px-3 pt-5 pb-2 text-xs font-semibold first:pt-1"
      >
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </Fragment>
  ));
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  // A plain button with the conversation rows' metrics, not a ghost Button restyled into one.
  return (
    <ThreadListPrimitive.New asChild>
      <button
        ref={ref}
        type="button"
        data-slot="aui_thread-list-new"
        className={cn(
          'hover:bg-foreground/[0.03] focus-visible:ring-ring/50 data-active:bg-foreground/[0.04] dark:data-active:bg-foreground/[0.06] flex w-full shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-start text-[13.5px] transition-colors outline-none focus-visible:ring-1',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon data-slot="aui_thread-list-new-icon" className="size-4 shrink-0" />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn('whitespace-nowrap', labelClassName)}
            >
              New Thread
            </span>
          </>
        )}
      </button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = 'ThreadListNew';

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="Loading threads"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-9 items-center px-3"
        >
          <Skeleton data-slot="aui_thread-list-skeleton" className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
};

export const ThreadListItem: FC = () => {
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const inCall = useAuiState((s) => s.threadListItem.custom?.inCall === true);
  const unread = useAuiState((s) => Number(s.threadListItem.custom?.unread ?? 0));
  const [isRenaming, setIsRenaming] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const openMoreFromLongPress = () => {
    if (longPressTriggeredRef.current) return;
    longPressTriggeredRef.current = true;
    setMoreOpen(true);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate?.(12);
    }
  };

  useEffect(() => clearLongPress, []);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group hover:bg-foreground/[0.03] has-focus-visible:bg-foreground/[0.03] has-data-[state=open]:bg-foreground/[0.03] data-active:bg-foreground/[0.04] dark:data-active:bg-foreground/[0.06] relative flex w-full items-center rounded-xl text-[13.5px] transition-colors focus-visible:outline-none"
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch' || isRenaming) return;
        clearLongPress();
        longPressTriggeredRef.current = false;
        longPressOriginRef.current = { x: event.clientX, y: event.clientY };
        longPressTimerRef.current = setTimeout(openMoreFromLongPress, 450);
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== 'touch') return;
        const origin = longPressOriginRef.current;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
          clearLongPress();
        }
      }}
      onPointerUp={() => {
        clearLongPress();
        longPressOriginRef.current = null;
      }}
      onPointerCancel={() => {
        clearLongPress();
        longPressOriginRef.current = null;
      }}
      onContextMenu={(event) => {
        if (window.matchMedia('(hover: none)').matches) {
          event.preventDefault();
          openMoreFromLongPress();
        }
      }}
      onClickCapture={(event) => {
        const target = event.target;
        if (
          !longPressTriggeredRef.current ||
          !(target instanceof Element) ||
          !target.closest('[data-slot="aui_thread-list-item-trigger"]')
        ) {
          return;
        }
        longPressTriggeredRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-start outline-none group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9 focus-visible:ring-1"
        >
          {isRunning && (
            <Loader2Icon
              aria-hidden
              data-slot="aui_thread-list-item-running"
              className="text-foreground/45 size-3.5 shrink-0 animate-spin"
            />
          )}
          {inCall && (
            <PhoneIcon
              aria-label="In call"
              data-slot="aui_thread-list-item-in-call"
              className="size-3.5 shrink-0 text-green-600"
            />
          )}
          <span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
            <ThreadListItemPrimitive.Title fallback="New Chat" />
          </span>
          {unread > 0 && (
            <span
              aria-label={`${unread} unread background ${unread === 1 ? 'result' : 'results'}`}
              data-slot="aui_thread-list-item-unread"
              className="bg-pink size-1.5 shrink-0 rounded-full group-hover:hidden group-data-active:hidden"
            />
          )}
          {isRunning && <span className="sr-only">Running</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore
        open={moreOpen}
        onOpenChange={(open) => {
          setMoreOpen(open);
          if (!open) longPressTriggeredRef.current = false;
        }}
        onRename={() => setIsRenaming(true)}
      />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? '';
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        }
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label="Rename thread"
      value={value}
      className="h-9 min-w-0 flex-1 rounded-xl ps-3 pe-9 text-[13.5px]"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const ThreadListItemMore: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
}> = ({ open, onOpenChange, onRename }) => {
  return (
    <ThreadListItemMorePrimitive.Root open={open} onOpenChange={onOpenChange} sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/90 data-[state=open]:bg-foreground/[0.06] absolute end-2 top-1/2 size-6 -translate-y-1/2 rounded-full p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:pointer-events-none [@media(hover:none)]:!opacity-0"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">More options</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="mobile-menu-motion bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          Rename
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <ArchiveIcon className="size-4" />
            Archive
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
