import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, MenuIcon, PlusIcon, SearchIcon, SettingsIcon } from 'lucide-react';
import { useAuiState } from '@assistant-ui/react';
import {
  ThreadListItems,
  ThreadListNew,
  ThreadListRoot,
} from '@/components/assistant-ui/elements/thread-list.aui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const QUIET_ICON_BUTTON =
  'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted size-9 justify-center rounded-full border-0 bg-transparent p-0 opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100 focus-visible:opacity-100 lg:transition-none';

/** Conversation list, driven by the assistant-ui thread list runtime. */
export function Sidebar({
  assistantName,
  error,
  searchOpen,
  onSearchOpenChange,
  newChatActive,
  onNewChat,
  onSettings,
}: {
  assistantName: string;
  error: string | null;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  /** No conversation is selected: the new chat is the page on screen. */
  newChatActive: boolean;
  onNewChat: () => void;
  onSettings: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');
  const activeThreadId = useAuiState((state) => state.threadListItem.id);
  const previousThreadId = useRef(activeThreadId);

  useEffect(() => {
    if (searchOpen && previousThreadId.current !== activeThreadId) {
      onSearchOpenChange(false);
    }
    if (previousThreadId.current !== activeThreadId) setMobileOpen(false);
    previousThreadId.current = activeThreadId;
  }, [activeThreadId, onSearchOpenChange, searchOpen]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const content = (
    <>
      <div className="flex items-center justify-between gap-2 ps-6 pe-4 pt-4 pb-2">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            setMobileOpen(false);
          }}
          aria-label={`${assistantName} — new chat`}
          title="New chat"
          className="font-display focus-visible:outline-ring cursor-pointer rounded-md text-3xl font-extrabold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          {assistantName}
        </button>
        <Button
          type="button"
          variant="ghost"
          aria-label="Search chats"
          title="Search chats"
          onClick={() => {
            setMobileOpen(false);
            onSearchOpenChange(true);
          }}
          className={`${QUIET_ICON_BUTTON} sidebar-search-button shrink-0 [@media(hover:none)]:opacity-100`}
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
          onClick={() => setMobileOpen(false)}
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
      </ThreadListRoot>
      <div className="shrink-0 p-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMobileOpen(false);
            onSettings();
          }}
          className="text-muted-foreground hover:text-foreground w-full justify-start gap-3 rounded-xl px-3"
        >
          <SettingsIcon className="size-4" />
          Settings
        </Button>
      </div>
    </>
  );

  return (
    <>
      <aside className="group/sidebar bg-background border-border/70 hidden w-64 shrink-0 flex-col border-e lg:flex lg:w-72">
        {content}
      </aside>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-label="Open chats"
            className="mobile-chat-trigger fixed z-30 size-11 rounded-full lg:hidden"
          >
            <MenuIcon className="size-5" />
          </Button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          overlayClassName="mobile-chat-backdrop"
          className="group/sidebar mobile-chat-drawer top-0 left-0 h-full max-h-none w-[min(18rem,85vw)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0 data-[state=closed]:animate-none data-[state=open]:animate-none lg:hidden"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Chats</DialogTitle>
          </DialogHeader>
          {content}
        </DialogContent>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={onSearchOpenChange}>
        <DialogContent className="mobile-search-page flex flex-col gap-3 p-4 sm:max-w-xl">
          <DialogHeader className="mobile-search-header text-start">
            <Button
              type="button"
              variant="ghost"
              aria-label="Back to chats"
              onClick={() => onSearchOpenChange(false)}
              className="mobile-search-back size-10 shrink-0 rounded-full p-0"
            >
              <ArrowLeftIcon className="size-5" />
            </Button>
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
          <div className="mobile-search-results max-h-[min(55vh,26rem)] min-h-12 overflow-y-auto">
            <ThreadListItems searchQuery={search} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
