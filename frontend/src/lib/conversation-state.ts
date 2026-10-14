import type { ChatMessage } from '@shared/chat-types';

export interface LiveConversationItem {
  turnId: string;
  message: ChatMessage;
}

export interface ConversationTaskStatus {
  id: string;
  title: string;
  status: 'running';
}

export type ConversationRequestStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ConversationField =
  'history' | 'live' | 'pending' | 'activeTurns' | 'tasks' | 'settledTurns' | 'stopped' | 'error';

export interface ConversationStoreState {
  conversationId: string | null | undefined;
  historyRequest: { revision: number; status: ConversationRequestStatus };
  history: ChatMessage[];
  live: LiveConversationItem[];
  pending: Extract<ChatMessage, { role: 'user' }> | null;
  activeTurns: string[];
  tasks: ConversationTaskStatus[];
  settledTurns: number;
  stopped: ReadonlySet<string>;
  error: string | null;
}

export type ConversationStatePatch = {
  [K in ConversationField]?:
    | ConversationStoreState[K]
    | ((previous: ConversationStoreState[K]) => ConversationStoreState[K]);
};

export type ConversationStateAction =
  | { type: 'activate'; conversationId: string | null; history: ChatMessage[] }
  | { type: 'history-requested'; conversationId: string; revision: number }
  | { type: 'history-loaded'; conversationId: string; revision: number; history: ChatMessage[] }
  | { type: 'history-failed'; conversationId: string; revision: number; message: string }
  | { type: 'patch'; conversationId: string | null | undefined; patch: ConversationStatePatch };

export const initialConversationState: ConversationStoreState = {
  conversationId: undefined,
  historyRequest: { revision: 0, status: 'idle' },
  history: [],
  live: [],
  pending: null,
  activeTurns: [],
  tasks: [],
  settledTurns: 0,
  stopped: new Set(),
  error: null,
};

/** Owns one displayed conversation and rejects stale request/event updates. */
export function conversationStateReducer(
  state: ConversationStoreState,
  action: ConversationStateAction
): ConversationStoreState {
  if (action.type === 'activate') {
    return {
      ...state,
      conversationId: action.conversationId,
      historyRequest: { revision: 0, status: action.conversationId ? 'ready' : 'idle' },
      history: action.history,
      live: [],
      activeTurns: [],
      tasks: [],
      error: null,
    };
  }
  if (action.type === 'history-requested') {
    if (
      state.conversationId !== action.conversationId ||
      action.revision < state.historyRequest.revision
    )
      return state;
    return { ...state, historyRequest: { revision: action.revision, status: 'loading' } };
  }
  if (action.type === 'history-loaded') {
    if (
      state.conversationId !== action.conversationId ||
      action.revision < state.historyRequest.revision
    )
      return state;
    return {
      ...state,
      history: action.history,
      historyRequest: { revision: action.revision, status: 'ready' },
    };
  }
  if (action.type === 'history-failed') {
    if (
      state.conversationId !== action.conversationId ||
      action.revision < state.historyRequest.revision
    )
      return state;
    return {
      ...state,
      historyRequest: { revision: action.revision, status: 'error' },
      error: action.message,
    };
  }
  if (state.conversationId !== action.conversationId) return state;
  const next: ConversationStoreState = { ...state };
  for (const key of Object.keys(action.patch) as ConversationField[]) {
    const value = action.patch[key];
    if (value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] =
      typeof value === 'function'
        ? (value as (previous: ConversationStoreState[typeof key]) => unknown)(state[key])
        : value;
  }
  return next;
}
