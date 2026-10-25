import { type RefObject, createContext } from 'react';
import type {
  ConversationContextUsage,
  ConversationSummary,
  TextEffort,
} from '@artemis/contracts/chat-types';
import {
  EMPTY_COMPONENTS,
  type ThreadComponents,
} from '@/components/chat-primitives/chat/thread-context';
import type { RecordingStatus } from '@/hooks/use-voice-recorder';
import type { AgentRun } from '@/lib/agent-runs';
import type { RunningTask } from '@/lib/conversation-state';

// The thread-level contexts of the chat app. chat-app.tsx composes the providers; the
// slots and primitives read them here. Every context lives in this one module.

/** App state the chat's thread slots need but assistant-ui does not track. */
export interface ChatThreadState {
  assistantName: string;
  contextUsage: ConversationContextUsage | null;
  effort: TextEffort;
  setEffort: (effort: TextEffort) => void;
  callButton: {
    label: string;
    disabled: boolean;
    active: boolean;
    onClick: () => void;
  };
  /** A turn is running in this conversation (text or voice). */
  busy: boolean;
  tasks: RunningTask[];
  error: string | null;
  /** Acknowledge background updates the user has seen. */
  markRead: (updateIds: string[]) => void;
  recentConversation: ConversationSummary | null;
  resumeConversation: (id: string) => void;
  conversationStats: { total: number; activeThisWeek: number } | null;
}

export const ChatThreadContext = createContext<ChatThreadState | null>(null);

/** The background tasks of the app, and how to open or stop one. */
type AppActivityState = {
  tasks: AgentRun[];
  openTask: (task: AgentRun) => void;
  stopTask: (id: string) => Promise<void>;
  stopping: Set<string>;
  error: string | null;
};

export const AppActivityContext = createContext<AppActivityState | null>(null);

/** The background runs a thread's tool calls show, and how to open one. */
export const ToolRunActivityContext = createContext<{
  tasks: AgentRun[];
  openTask: (task: AgentRun) => void;
} | null>(null);

/** Optional rendering slots supplied by the chat application. */
export const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

/** Slots report here when the user double-clicks the welcome line into the easter egg. */
export const EasterEggContext = createContext<(enabled: boolean) => void>(() => {});

/** The composer reports its voice input state, so the overlay can show it. */
export const RecordingStatusContext = createContext<(status: RecordingStatus) => void>(() => {});

/** The mascot's root element, so other parts of the chat can measure it without a DOM query. */
export const MascotElementContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
