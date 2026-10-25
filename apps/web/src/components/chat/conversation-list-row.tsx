import { type FC, useEffect, useRef, useState } from 'react';
import { ArchiveIcon, Loader2Icon, MoreHorizontalIcon, PencilIcon, PhoneIcon } from 'lucide-react';
import {
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useLongPress } from '@react-aria/interactions';
import { SidebarItem } from '@/components/chat/sidebar-item';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const ThreadListItem = () => {
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
