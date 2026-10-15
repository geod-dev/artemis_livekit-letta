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
import { Command } from 'cmdk';
import {
  ArchiveIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
} from 'lucide-react';
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useLongPress } from '@react-aria/interactions';
import { SidebarItem } from '@/components/chat/sidebar-item';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/shadcn/utils';

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

type ThreadListGroup = { label: string; indices: number[] };

/**
 * Filters the thread list by title and buckets the matches by last activity
 * (Today, Yesterday, Earlier). `groups` is null when no thread carries a date
 * or while the local day start is unknown during server render and hydration,
 * in which case `filteredIndices` keeps the runtime order.
 */
const useThreadListGroups = (searchQuery = '') => {
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
        className="text-muted-foreground/60 px-px pt-5 pb-2 text-xs font-medium first:pt-1"
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

/** Search results are command options, separate from the sidebar's action buttons. */
export function ThreadSearchResults({
  searchQuery,
  onSelect,
}: {
  searchQuery: string;
  onSelect: () => void;
}) {
  const aui = useAui();
  const loading = useAuiState((s) => s.threads.isLoading);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const { threadIds, filteredIndices, groups } = useThreadListGroups(searchQuery);
  const itemsById = new Map(threadItems.map((item) => [item.id, item]));

  if (loading) return <ThreadListSkeleton />;

  const renderItem = (index: number) => {
    const id = threadIds[index];
    return (
      <Command.Item
        key={id}
        value={id}
        onSelect={() => {
          aui.threads.switchToThread(id);
          onSelect();
        }}
        className="text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground flex min-h-10 cursor-pointer items-center rounded-[var(--control-radius)] px-3 py-2 text-[13.5px] outline-none"
      >
        <span className="truncate">{itemsById.get(id)?.title || 'New Chat'}</span>
      </Command.Item>
    );
  };

  return (
    <>
      <Command.Empty className="text-muted-foreground px-3 py-4 text-[13.5px]">
        No threads found
      </Command.Empty>
      {groups
        ? groups.map((group) => (
            <Command.Group
              key={group.label}
              heading={group.label}
              className="[&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-px [&_[cmdk-group-heading]]:pt-5 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium first:[&_[cmdk-group-heading]]:pt-1"
            >
              {group.indices.map(renderItem)}
            </Command.Group>
          ))
        : filteredIndices.map(renderItem)}
    </>
  );
}

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <SidebarItem
        ref={ref}
        type="button"
        data-slot="aui_thread-list-new"
        className={cn('shrink-0', className)}
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
      </SidebarItem>
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

const ThreadListItem = () => {
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const inCall = useAuiState((s) => s.threadListItem.custom?.inCall === true);
  const unread = useAuiState((s) => Number(s.threadListItem.custom?.unread ?? 0));
  const [isRenaming, setIsRenaming] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const longPressTriggeredRef = useRef(false);
  const { longPressProps } = useLongPress({
    isDisabled: isRenaming,
    pointerType: 'touch',
    threshold: 450,
    accessibilityDescription: 'Long press to open conversation options',
    onLongPressStart: () => {
      longPressTriggeredRef.current = false;
    },
    onLongPress: () => {
      longPressTriggeredRef.current = true;
      setMoreOpen(true);
      navigator.vibrate?.(12);
    },
  });

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group relative flex w-full items-center rounded-[var(--control-radius)] transition-colors focus-visible:outline-none"
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger asChild>
          <SidebarItem
            {...longPressProps}
            onClickCapture={(event) => {
              // assistant-ui activates on click; React Aria cancels press events.
              if (!longPressTriggeredRef.current) return;
              longPressTriggeredRef.current = false;
              event.preventDefault();
              event.stopPropagation();
            }}
            ref={triggerRef}
            data-slot="aui_thread-list-item-trigger"
            className="min-w-0 flex-1 group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9"
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
          </SidebarItem>
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
          className="text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/90 data-[state=open]:bg-foreground/[0.06] absolute end-2 top-1/2 size-6 -translate-y-1/2 rounded-full p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:size-9 [@media(hover:none)]:opacity-100"
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
        className="mobile-menu-motion surface-panel text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-[var(--popover-radius)] p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-[var(--menu-item-radius)] px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          Rename
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-[var(--menu-item-radius)] px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <ArchiveIcon className="size-4" />
            Archive
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
