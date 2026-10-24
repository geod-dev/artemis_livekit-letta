import type { ComponentType, PropsWithChildren, RefObject } from 'react';
import type { ConversationContextUsage } from '@artemis/contracts/chat-types';
import { TOOL_NAMES } from '@artemis/contracts/tool-names';
import {
  MessagePrimitive,
  type ToolCallMessagePartComponent,
  groupPartByType,
} from '@assistant-ui/react';
import type { RecordingStatus } from '@/hooks/use-voice-recorder';

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/** Props of the overlay slot, drawn over the thread by the app. */
export type ThreadOverlayProps = {
  viewportRef: RefObject<HTMLDivElement | null>;
  easterEggEnabled: boolean;
  recordingStatus: RecordingStatus;
};

/** Optional rendering slots supplied by the chat application. */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  SystemMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  BeforeComposer?: ComponentType | undefined;
  ComposerEffort?: ComponentType | undefined;
  /** Shown under the starter prompts of a new chat. */
  WelcomeFooter?: ComponentType<{ tabIndex: number }> | undefined;
  /** Drawn behind the messages once the conversation has some. */
  Backdrop?: ComponentType<{ viewportRef: RefObject<HTMLDivElement | null> }> | undefined;
  /** Drawn over the thread, for example the app's mascot. */
  Overlay?: ComponentType<ThreadOverlayProps> | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
};

/** The composer's call button, as the app describes it. */
export type ThreadCallButton = {
  label: string;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  callButton: ThreadCallButton;
  contextUsage: ConversationContextUsage | null;
  autoFocus?: boolean | undefined;
  placeholder?: string | undefined;
};

export const EMPTY_COMPONENTS: ThreadComponents = {};

const messageGroupBy = groupPartByType({
  reasoning: ['group-chainOfThought', 'group-reasoning'],
  'tool-call': ['group-chainOfThought', 'group-tool'],
  'standalone-tool-call': [],
});

export const defaultGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1]
) => {
  if (part.type === 'tool-call' && part.toolName === TOOL_NAMES.runAgent) return [];
  return messageGroupBy(part, context);
};
