import { createContext, useContext } from 'react';
import type {
  ConversationContextUsage,
  ConversationSummary,
  TextEffort,
} from '@artemis/contracts/chat-types';
import type { RunningTask } from '@/lib/conversation-state';

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

export function useChatThread() {
  const state = useContext(ChatThreadContext);
  if (!state) throw new Error('ChatThreadContext is missing');
  return state;
}
