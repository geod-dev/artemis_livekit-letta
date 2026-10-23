import { type FC } from 'react';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from 'lucide-react';
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
} from '@assistant-ui/react';
import { IconButton } from '@/components/assistant-ui/shared/icon-button';
import { Button } from '@/components/ui/button';

export const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <IconButton label="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </IconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <IconButton label="More" className="data-[state=open]:bg-accent">
            <MoreHorizontalIcon />
          </IconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content mobile-menu-motion surface-panel text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-[var(--popover-radius)] p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-[var(--menu-item-radius)] px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

export const UserActionBar: FC = () => {
  const aui = useAui();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root text-muted-foreground animate-in fade-in -me-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <IconButton label="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </IconButton>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(s) => s.thread.capabilities.edit}>
        <ActionBarPrimitive.Edit asChild>
          <IconButton label="Edit" className="aui-user-action-edit">
            <PencilIcon />
          </IconButton>
        </ActionBarPrimitive.Edit>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.capabilities.delete}>
        <ActionBarMorePrimitive.Root>
          <ActionBarMorePrimitive.Trigger asChild>
            <IconButton label="More" className="data-[state=open]:bg-accent">
              <MoreHorizontalIcon />
            </IconButton>
          </ActionBarMorePrimitive.Trigger>
          <ActionBarMorePrimitive.Content
            side="bottom"
            align="end"
            sideOffset={6}
            className="aui-action-bar-more-content mobile-menu-motion surface-panel text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out z-50 min-w-[8rem] overflow-hidden rounded-[var(--popover-radius)] p-1.5"
          >
            <ActionBarMorePrimitive.Item
              onSelect={() => void aui.message.delete()}
              className="aui-action-bar-more-item text-destructive hover:bg-destructive/10 focus:bg-destructive/10 flex cursor-pointer items-center gap-2 rounded-[var(--menu-item-radius)] px-2.5 py-1.5 text-sm outline-none select-none"
            >
              <TrashIcon className="size-4" />
              Delete
            </ActionBarMorePrimitive.Item>
          </ActionBarMorePrimitive.Content>
        </ActionBarMorePrimitive.Root>
      </AuiIf>
    </ActionBarPrimitive.Root>
  );
};

export const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root surface-panel border-foreground/10 focus-within:border-foreground/25 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--surface-radius) transition-[border-color]">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};
