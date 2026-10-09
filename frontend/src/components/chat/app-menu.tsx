import { MoreHorizontalIcon, PlusIcon, SearchIcon, SettingsIcon } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button';

const ITEM =
  'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none';
const SHORTCUT = 'text-muted-foreground ms-auto ps-6 text-xs';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

/** The header's menu: app-wide actions, reachable on every screen size. */
export function AppMenu({
  onNewChat,
  onSearch,
  onSettings,
}: {
  onNewChat: () => void;
  onSearch: () => void;
  onSettings: () => void;
}) {
  return (
    // Not modal: its items open dialogs, and a modal menu closing under an
    // opening dialog can leave the page without pointer events.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <TooltipIconButton
          tooltip="More"
          side="bottom"
          type="button"
          className="text-muted-foreground hover:bg-muted data-[state=open]:bg-muted size-9 rounded-full"
        >
          <MoreHorizontalIcon className="size-4" />
        </TooltipIconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 z-50 min-w-48 overflow-hidden rounded-xl border p-1.5"
        >
          <DropdownMenu.Item className={ITEM} onSelect={onNewChat}>
            <PlusIcon className="size-4" />
            New chat
            <span className={SHORTCUT}>{MOD}N</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={onSearch}>
            <SearchIcon className="size-4" />
            Search chats
            <span className={SHORTCUT}>{MOD}K</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="bg-border -mx-1.5 my-1.5 h-px" />
          <DropdownMenu.Item className={ITEM} onSelect={onSettings}>
            <SettingsIcon className="size-4" />
            Settings
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
