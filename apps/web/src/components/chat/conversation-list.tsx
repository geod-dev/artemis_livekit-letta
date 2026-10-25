import { type ComponentPropsWithoutRef, type FC, Fragment, forwardRef } from 'react';
import { Command } from 'cmdk';
import { PlusIcon } from 'lucide-react';
import { AuiIf, ThreadListPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { ThreadListItem } from '@/components/chat/conversation-list-row';
import { SidebarItem } from '@/components/chat/sidebar-item';
import { Skeleton } from '@/components/ui/skeleton';
import { useThreadListGroups } from '@/hooks/use-thread-list-groups';
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
    if (id === undefined) return null;
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
