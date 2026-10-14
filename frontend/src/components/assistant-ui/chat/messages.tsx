import { type FC, type PropsWithChildren, useContext } from 'react';
import { AudioLinesIcon, SquareIcon } from 'lucide-react';
import {
  ErrorPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  MessagePrimitive,
  useAuiState,
} from '@assistant-ui/react';
import {
  AssistantActionBar,
  EditComposer,
  UserActionBar,
} from '@/components/assistant-ui/chat/actions';
import { DayHeader } from '@/components/assistant-ui/chat/day-separator';
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/assistant-ui/chat/reasoning-message';
import {
  ThreadComponentsContext,
  type ThreadGroupPart,
  defaultGroupBy,
  taskAwareGroupBy,
} from '@/components/assistant-ui/chat/thread-context';
import { UserMessageAttachments } from '@/components/assistant-ui/composer/attachment';
import { File } from '@/components/assistant-ui/files/file';
import { Image } from '@/components/assistant-ui/files/image';
import {
  MarkdownText,
  MessageLinkPreviews,
} from '@/components/assistant-ui/markdown/markdown-text';
import { field, mono } from '@/components/assistant-ui/shared/surfaces';
import {
  type ToolCall,
  getToolGroupDisplay,
  getToolGroupLabel,
  toolCall,
} from '@/components/assistant-ui/tools/tool-display';
import { ToolFallback } from '@/components/assistant-ui/tools/tool-fallback';
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from '@/components/assistant-ui/tools/tool-group';
import { dayKey, dayLabel, timeLabel } from '@/lib/message-days';
import { cn } from '@/lib/shadcn/utils';

const reasoningDuration = (timing: ThreadGroupPart['timing']) =>
  timing?.completedAt === undefined
    ? undefined
    : Math.round((timing.completedAt - timing.startedAt) / 1000);
export const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = AssistantMessage,
    SystemMessage: SystemMessageComponent = SystemMessage,
  } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  return (
    <>
      <MessageDayHeader />
      {isEditing ? (
        <EditComposer />
      ) : role === 'user' ? (
        <UserMessage />
      ) : role === 'system' ? (
        <SystemMessageComponent />
      ) : (
        <AssistantMessageComponent />
      )}
    </>
  );
};

/** Opens a new day: shown above a message dated on a later day than the one before it. */
const MessageDayHeader: FC = () => {
  const day = useAuiState((s) => {
    const here = s.message.createdAt;
    if (!here) return null;
    const previous = s.thread.messages[s.message.index - 1]?.createdAt;
    const key = dayKey(here);
    return previous && dayKey(previous) === key ? null : key;
  });
  if (!day) return null;
  return <DayHeader day={dayLabel(day)} className="-mb-2 px-2" />;
};

/** The message's time of day, revealed while its row is hovered. */
const MessageTime: FC<{ className?: string }> = ({ className }) => {
  const time = useAuiState((s) => (s.message.createdAt ? timeLabel(s.message.createdAt) : null));
  if (!time) return null;
  return (
    <span
      data-slot="aui_message-time"
      className={cn(
        mono,
        'text-foreground/0 group-hover/message:text-foreground/35 shrink-0 tabular-nums transition-colors',
        className
      )}
    >
      {time}
    </span>
  );
};

const SystemMessage: FC = () => (
  <MessagePrimitive.Root
    data-slot="aui_system-message-root"
    data-role="system"
    className="text-muted-foreground px-2 text-center text-xs"
  >
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root bg-destructive mt-2 rounded-2xl px-4 py-3 text-sm font-bold text-white">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/** A reply the user stopped: what arrived before the stop stays, with a note under it. */
const StoppedNotice: FC = () => {
  const stopped = useAuiState(
    (s) =>
      s.message.role === 'assistant' &&
      s.message.status?.type === 'incomplete' &&
      s.message.status.reason === 'cancelled'
  );
  if (!stopped) return null;
  return (
    <span
      data-slot="aui_stopped-notice"
      className={cn(
        field,
        mono,
        'text-muted-foreground animate-in fade-in mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 duration-200 first:mt-0'
      )}
    >
      <SquareIcon className="size-2.5 fill-current" aria-hidden />
      stopped by you
    </span>
  );
};

/** The tool calls of a group, as displays read them. */
function groupCalls(
  parts: readonly { type: string; toolName?: string; argsText?: string }[],
  group: ThreadGroupPart
): ToolCall[] {
  return group.indices.flatMap((index) => {
    const part = parts[index];
    return part?.type === 'tool-call' && part.toolName
      ? [toolCall(part.toolName, part.argsText)]
      : [];
  });
}

/** Group dropdown that adopts the display its calls share (see `tool-display.ts`). */
const ToolCallGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({ group, children }) => {
  // Displays are module constants and labels strings: the selections only
  // change when the group's display or label does.
  const display = useAuiState((s) => getToolGroupDisplay(groupCalls(s.message.parts, group)));
  const label = useAuiState((s) => getToolGroupLabel(groupCalls(s.message.parts, group)));

  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger
        active={group.status.type === 'running'}
        icon={display.icon}
        label={label}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : defaultGroupBy;

  const ACTION_BAR_PT = 'pt-1.5';
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message animate-pop-in relative -mb-7.5 pb-7.5"
    >
      <div
        data-slot="aui_assistant-message-content"
        data-mascot-message=""
        className="peer/content text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case 'group-chainOfThought':
                return (
                  <div data-slot="aui_chain-of-thought" className="mb-1.5 last:mb-0">
                    {children}
                  </div>
                );
              case 'group-task':
                return TaskGroupComponent ? <TaskGroupComponent group={part} /> : null;
              case 'group-tool':
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                // A lone tool call renders inline; collapsing a single item adds a click for nothing.
                if (part.indices.length === 1) {
                  return children;
                }
                return <ToolCallGroup group={part}>{children}</ToolCallGroup>;
              case 'group-reasoning': {
                if (ReasoningGroup) {
                  return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                }
                const running = part.status.type === 'running';
                return (
                  <ReasoningRoot
                    variant="ghost"
                    className="mb-0"
                    streaming={running}
                    expandWhileStreaming={false}
                  >
                    <ReasoningTrigger active={running} duration={reasoningDuration(part.timing)} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case 'text':
                return <MarkdownText />;
              case 'reasoning':
                return <Reasoning {...part} />;
              case 'tool-call':
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case 'data':
                return part.dataRendererUI;
              case 'indicator':
                return (
                  // An empty box where the reply will start: the mascot waits here.
                  <span
                    data-slot="aui_assistant-message-indicator"
                    data-mascot-anchor="waiting"
                    role="status"
                    aria-label="Assistant is working"
                    className="inline-block h-7 w-6 align-middle"
                  />
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
        <StoppedNotice />
      </div>
      <MessageLinkPreviews />

      {/* When the mascot drops below the reply, the actions sit beside it. */}
      <div
        data-slot="aui_assistant-message-footer"
        className={cn(
          'ms-2 flex items-center transition-[margin] duration-200 peer-data-[mascot-wrapped]/content:ms-12',
          ACTION_BAR_HEIGHT
        )}
      >
        <AssistantActionBar />
        <MessageTime className="ms-1.5" />
      </div>
    </MessagePrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessage: FC = () => {
  const isSpoken = useAuiState((s) => s.message.metadata.modality === 'voice');
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/message animate-pop-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div
          className={cn(
            'aui-user-message-content peer bg-surface-alternate text-foreground rounded-[var(--control-radius)] rounded-br-[0.625rem] border border-white/40 px-5 py-3 text-[15px] leading-relaxed font-medium wrap-break-word empty:hidden',
            isSpoken && 'italic'
          )}
        >
          {isSpoken ? (
            <div className="flex items-start gap-2">
              {/* Centered on the first line of text. */}
              <AudioLinesIcon
                aria-label="Said in a call"
                className="mt-[calc((1lh-0.875rem)/2)] size-3.5 shrink-0 opacity-70"
              />
              <div className="min-w-0">
                <MessagePrimitive.Parts components={{ File: UserFilePart, Image: UserImagePart }} />
              </div>
            </div>
          ) : (
            <MessagePrimitive.Parts components={{ File: UserFilePart, Image: UserImagePart }} />
          )}
        </div>
      </div>

      <div
        data-slot="aui_user-message-footer"
        className="col-span-full col-start-1 -mt-1 flex min-h-7 items-center justify-end gap-1"
      >
        <MessageTime className="me-1.5" />
        <UserActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};
