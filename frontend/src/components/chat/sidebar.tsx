import { useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { MenuIcon, MessageCirclePlusIcon, SearchIcon, SettingsIcon, XIcon } from 'lucide-react';
import { useAuiState } from '@assistant-ui/react';
import Drawer from '@mui/material/Drawer';
import {
  ThreadListItems,
  ThreadListNew,
  ThreadListRoot,
  ThreadSearchResults,
} from '@/components/assistant-ui/chat/thread-list';
import { SidebarItem } from '@/components/chat/sidebar-item';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

const QUIET_ICON_BUTTON =
  'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted size-9 justify-center rounded-[var(--control-radius)] border-0 bg-transparent p-0 opacity-100 transition-colors duration-150';

/** Conversation list, driven by the assistant-ui thread list runtime. */
export function Sidebar({
  assistantName,
  error,
  searchOpen,
  onSearchOpenChange,
  newChatActive,
  settingsActive,
  onNewChat,
  onSettings,
}: {
  assistantName: string;
  error: string | null;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  /** No conversation is selected: the new chat is the page on screen. */
  newChatActive: boolean;
  settingsActive: boolean;
  onNewChat: () => void;
  onSettings: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(
    () => !window.matchMedia('(min-width: 1024px)').matches
  );
  const [search, setSearch] = useState('');
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);
  const drawerPaper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileViewport || searchOpen || (!mobileOpen && settingsActive)) return;
    const direction = mobileOpen ? -1 : 1;

    let gesture: { x: number; y: number; distance: number; dragging: boolean } | null = null;
    const start = (event: TouchEvent) => {
      if (event.defaultPrevented || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture = { x: touch.clientX, y: touch.clientY, distance: 0, dragging: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        gesture = null;
        setSwipeOffset(null);
        return;
      }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = Math.abs(event.touches[0].clientY - gesture.y);
      if (!gesture.dragging) {
        if (Math.max(Math.abs(dx), dy) < 8) return;
        // Lock direction once, so scrolling never turns into a sidebar gesture.
        if (dx * direction <= dy) {
          gesture = null;
          return;
        }
        gesture.dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      gesture.distance = Math.min(
        Math.max(dx * direction, 0),
        drawerPaper.current?.clientWidth ?? 288
      );
      setSwipeOffset(gesture.distance * direction);
    };
    const finish = (event: TouchEvent) => {
      if (gesture?.dragging && event.type !== 'touchcancel') {
        const width = drawerPaper.current?.clientWidth ?? 288;
        if (gesture.distance > Math.min(64, width * 0.25)) setMobileOpen(!mobileOpen);
      }
      gesture = null;
      setSwipeOffset(null);
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', finish);
    document.addEventListener('touchcancel', finish);
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', finish);
      document.removeEventListener('touchcancel', finish);
    };
  }, [mobileViewport, mobileOpen, searchOpen, settingsActive]);

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
      setMobileViewport(!desktop.matches);
      if (desktop.matches) setMobileOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const content = (
    <>
      <div className="sidebar-brand flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            setMobileOpen(false);
          }}
          aria-label={`${assistantName} — new chat`}
          className="sidebar-wordmark font-display focus-visible:outline-ring cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          {assistantName}
          <span className="brand-period" aria-hidden="true">
            .
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          aria-label="Search chats"
          onClick={() => {
            setMobileOpen(false);
            onSearchOpenChange(true);
          }}
          className={`${QUIET_ICON_BUTTON} sidebar-search-button shrink-0 [@media(hover:none)]:opacity-100`}
        >
          <SearchIcon className="size-5" />
        </Button>
      </div>
      <ThreadListRoot className="min-h-0 flex-1 px-3">
        {/* A page like the chats below, and like the logo bar it stays put while they scroll.
            Its active state is ours: assistant-ui's needs a thread id the new chat does not have. */}
        <ThreadListNew
          data-active={newChatActive ? 'true' : undefined}
          aria-current={newChatActive ? 'page' : undefined}
          onClick={() => setMobileOpen(false)}
          className="mb-2"
        >
          <MessageCirclePlusIcon className="size-4 shrink-0" />
          New conversation
        </ThreadListNew>
        {error && (
          <p className="task-error mb-2 rounded-xl px-3 py-2 text-xs">
            Can’t reach {assistantName}: {error}
          </p>
        )}
        <ThreadListItems className="-mx-1 overflow-y-auto px-1" />
      </ThreadListRoot>
      <div className="sidebar-footer shrink-0 px-3 pt-3 pb-3">
        <SidebarItem
          type="button"
          data-active={settingsActive ? 'true' : undefined}
          onClick={() => {
            setMobileOpen(false);
            onSettings();
          }}
          className="w-full shrink-0"
        >
          <SettingsIcon className="size-4" />
          Settings
        </SidebarItem>
      </div>
    </>
  );

  return (
    <>
      <aside className="app-sidebar surface-panel group/sidebar hidden w-64 shrink-0 flex-col lg:flex lg:w-72">
        {content}
      </aside>
      <Button
        type="button"
        variant="ghost"
        aria-label="Open chats"
        aria-haspopup="dialog"
        aria-expanded={mobileOpen}
        aria-controls={mobileOpen ? 'mobile-chat-drawer' : undefined}
        onClick={() => setMobileOpen(true)}
        className="mobile-chat-trigger fixed z-30 size-11 rounded-full lg:hidden"
      >
        <MenuIcon className="size-5" />
      </Button>
      {mobileViewport && (
        <Drawer
          anchor="left"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          transitionDuration={240}
          slotProps={{
            root: {
              style: { zIndex: 50, ...(swipeOffset !== null && { visibility: 'visible' }) },
            },
            paper: {
              ref: (element: unknown) => {
                drawerPaper.current = element instanceof HTMLDivElement ? element : null;
              },
              style: {
                ...(swipeOffset !== null && { visibility: 'visible' }),
                translate: `${swipeOffset ?? 0}px 0`,
                transition: swipeOffset !== null ? 'none' : undefined,
              },
              id: 'mobile-chat-drawer',
              role: 'dialog',
              'aria-modal': mobileOpen ? true : undefined,
              'aria-labelledby': 'mobile-chat-drawer-title',
              className: `app-sidebar surface-panel mobile-chat-drawer group/sidebar${swipeOffset !== null ? ' is-dragging' : ''}`,
            },
            backdrop: {
              className: 'mobile-chat-backdrop',
              style:
                swipeOffset !== null
                  ? {
                      opacity:
                        (mobileOpen ? 1 : 0) +
                        swipeOffset / (drawerPaper.current?.clientWidth || 288),
                      visibility: 'visible',
                      transition: 'none',
                    }
                  : undefined,
            },
          }}
        >
          <h2 id="mobile-chat-drawer-title" className="sr-only">
            Chats
          </h2>
          {content}
        </Drawer>
      )}
      <Dialog open={searchOpen} onOpenChange={onSearchOpenChange}>
        <DialogContent
          showCloseButton={false}
          aria-label="Search chats"
          className="mobile-search-page flex flex-col gap-3 rounded-[var(--surface-radius)] p-4 sm:max-w-xl"
        >
          <Command
            label="Search chats"
            shouldFilter={false}
            loop
            className="flex min-h-0 flex-1 flex-col gap-3"
          >
            <div className="search-dialog-field flex h-11 shrink-0 items-center gap-2 rounded-[var(--control-radius)]">
              <Button
                type="button"
                variant="ghost"
                aria-label="Close search"
                onClick={() => onSearchOpenChange(false)}
                className="text-muted-foreground hover:text-foreground order-2 size-9 shrink-0 rounded-full p-0"
              >
                <XIcon className="size-4" />
              </Button>
              <Command.Input
                autoFocus
                value={search}
                onValueChange={setSearch}
                placeholder="Search chats"
                aria-label="Search chats"
                className="order-1 h-full min-w-0 flex-1 bg-transparent px-2 text-base outline-none md:text-sm"
              />
            </div>
            <Command.List
              aria-label="Conversations"
              className="mobile-search-results max-h-[min(55vh,26rem)] min-h-12 overflow-y-auto"
            >
              <ThreadSearchResults
                searchQuery={search}
                onSelect={() => onSearchOpenChange(false)}
              />
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
