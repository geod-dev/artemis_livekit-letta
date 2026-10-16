import { type ComponentType, type PropsWithChildren, createContext } from 'react';
import {
  MessagePrimitive,
  type ToolCallMessagePartComponent,
  groupPartByType,
} from '@assistant-ui/react';

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/** Optional rendering slots supplied by the chat application. */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  SystemMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  BeforeComposer?: ComponentType | undefined;
  ComposerEffort?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  placeholder?: string | undefined;
};

export const EMPTY_COMPONENTS: ThreadComponents = {};
export const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

const messageGroupBy = groupPartByType({
  reasoning: ['group-chainOfThought', 'group-reasoning'],
  'tool-call': ['group-chainOfThought', 'group-tool'],
  'standalone-tool-call': [],
});

type ThreadGroupKey = 'group-chainOfThought' | 'group-reasoning' | 'group-tool' | 'group-task';
const TASK_GROUP_PATH: readonly ThreadGroupKey[] = ['group-chainOfThought', 'group-task'];

export const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1]
): readonly ThreadGroupKey[] => {
  const path = defaultGroupBy(part, context);
  return part.type === 'tool-call' &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

export const defaultGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1]
): readonly ThreadGroupKey[] => {
  if (part.type === 'tool-call' && ['Agent', 'Task'].includes(part.toolName)) return [];
  return messageGroupBy(part, context);
};
