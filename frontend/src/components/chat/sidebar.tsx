import { useEffect, useRef, useState } from 'react';
import { PlusIcon, SearchIcon } from 'lucide-react';
import { useAuiState } from '@assistant-ui/react';
import {
  ThreadListItems,
  ThreadListNew,
  ThreadListRoot,
} from '@/components/assistant-ui/elements/thread-list.aui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const QUIET_ICON_BUTTON =
  'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted size-9 justify-center rounded-full border-0 bg-transparent p-0 opacity-0 transition-opacity group-hover/sidebar:opacity-100 focus-visible:opacity-100';

/** Conversation list, driven by the assistant-ui thread list runtime. */
export function Sidebar({
  assistantName,
  error,
  searchOpen,
  onSearchOpenChange,
  newChatActive,
}: {
  assistantName: string;
  error: string | null;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  /** No conversation is selected: the new chat is the page on screen. */
  newChatActive: boolean;
}) {
  const [search, setSearch] = useState('');
  const activeThreadId = useAuiState((state) => state.threadListItem.id);
  const previousThreadId = useRef(activeThreadId);

  useEffect(() => {
    if (searchOpen && previousThreadId.current !== activeThreadId) {
      onSearchOpenChange(false);
    }
    previousThreadId.current = activeThreadId;
  }, [activeThreadId, onSearchOpenChange, searchOpen]);

  return (
    <aside className="group/sidebar bg-background border-border/70 hidden w-72 shrink-0 flex-col border-e md:flex">
      <div className="flex items-center justify-between gap-2 ps-6 pe-4 pt-6 pb-2">
        <span className="font-display text-3xl font-extrabold tracking-tight">{assistantName}</span>
        <Button
          type="button"
          variant="ghost"
          aria-label="Search chats"
          title="Search chats"
          onClick={() => onSearchOpenChange(true)}
          className={QUIET_ICON_BUTTON}
        >
          <SearchIcon className="size-5" />
        </Button>
      </div>
      <ThreadListRoot className="min-h-0 flex-1 px-3 pb-3">
        {/* A page like the chats below, and like the logo bar it stays put while they scroll.
            Its active state is ours: assistant-ui's needs a thread id the new chat does not have. */}
        <ThreadListNew
          data-active={newChatActive ? 'true' : undefined}
          aria-current={newChatActive ? 'page' : undefined}
          className="mb-2"
        >
          <PlusIcon className="size-4 shrink-0" />
          New chat
        </ThreadListNew>
        {error && (
          <p className="bg-destructive mb-2 rounded-xl px-3 py-2 text-xs font-bold text-white">
            Can’t reach {assistantName}: {error}
          </p>
        )}
        <ThreadListItems className="-mx-1 overflow-y-auto px-1" />
        <Dialog open={searchOpen} onOpenChange={onSearchOpenChange}>
          <DialogContent className="gap-3 p-4 sm:max-w-xl">
            <DialogHeader className="pe-8 text-start">
              <DialogTitle>Search chats</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-11 rounded-xl"
            />
            <div className="max-h-[min(55vh,26rem)] min-h-12 overflow-y-auto">
              <ThreadListItems searchQuery={search} />
            </div>
          </DialogContent>
        </Dialog>
      </ThreadListRoot>
    </aside>
  );
}
