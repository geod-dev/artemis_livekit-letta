import { EventEmitter } from 'node:events';
import type { ConversationEvent, ConversationListEvent } from '../../chat-types';

/**
 * In-process pub/sub for live conversation events. Snapshot state retains only
 * currently active turns/tasks; completed event history is never kept here.
 */
const hub = new EventEmitter().setMaxListeners(0);
type ActiveEvent = Exclude<ConversationEvent, { type: 'snapshot' }>;
const activeTurns = new Map<
  string,
  Map<string, { turnId: string; modality: 'text' | 'voice'; events: ActiveEvent[] }>
>();
const liveTasks = new Map<
  string,
  Map<string, { taskId: string; status: 'running' | 'finished'; title: string }>
>();
const touched = new Map<string, number>();
const MAX_STATES = 128;
const MAX_STATE_AGE_MS = 30 * 60_000;
const MAX_TURNS_PER_CONVERSATION = 4;
const MAX_TASKS_PER_CONVERSATION = 64;
const MAX_EVENTS_PER_TURN = 32;
const MAX_TEXT_PER_DELTA = 64 * 1024;
const MAX_ACTIVE_TEXT_PER_TURN = 128 * 1024;

/** Channel for changes that concern the conversation list (e.g. unread counts). */
const LIST = Symbol.for('conversation-list');

export function publish(conversationId: string, event: ConversationEvent): void {
  touch(conversationId);
  if (event.type === 'turn_start') {
    const turns = activeTurns.get(conversationId) ?? new Map();
    if (turns.size >= MAX_TURNS_PER_CONVERSATION) turns.delete(turns.keys().next().value!);
    turns.set(event.turnId, { turnId: event.turnId, modality: event.modality, events: [event] });
    activeTurns.set(conversationId, turns);
  } else if (event.type === 'turn_end') {
    const turns = activeTurns.get(conversationId);
    turns?.delete(event.turnId);
    if (!turns?.size) activeTurns.delete(conversationId);
  } else if (event.type === 'task') {
    const tasks = liveTasks.get(conversationId) ?? new Map();
    if (event.status === 'finished') tasks.delete(event.taskId);
    else {
      if (tasks.size >= MAX_TASKS_PER_CONVERSATION) tasks.delete(tasks.keys().next().value!);
      tasks.set(event.taskId, {
        taskId: event.taskId,
        status: event.status,
        title: event.title.slice(0, 500),
      });
    }
    if (tasks.size) liveTasks.set(conversationId, tasks);
    else liveTasks.delete(conversationId);
  }
  recordActiveEvent(conversationId, event);
  if (!activeTurns.has(conversationId) && !liveTasks.has(conversationId))
    clearState(conversationId);
  hub.emit(conversationId, event);
}

export function subscribe(
  conversationId: string,
  listener: (event: ConversationEvent) => void
): () => void {
  hub.on(conversationId, listener);
  return () => hub.off(conversationId, listener);
}

/** Subscribe first, then reconcile current active work and its projected output. */
export function subscribeWithSnapshot(
  conversationId: string,
  listener: (event: ConversationEvent) => void
): () => void {
  const unsubscribe = subscribe(conversationId, listener);
  try {
    touch(conversationId);
    const turns = activeTurns.get(conversationId);
    listener({
      type: 'snapshot',
      turns: [...(turns?.values() ?? [])].map(({ turnId, modality }) => ({ turnId, modality })),
      tasks: [...(liveTasks.get(conversationId)?.values() ?? [])],
      activeEvents: [...(turns?.values() ?? [])].flatMap((turn) => turn.events),
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}

/** Forget state once its conversation is archived or its history is forked. */
export function clearConversationEvents(conversationId: string): void {
  clearState(conversationId);
}

function recordActiveEvent(conversationId: string, event: ConversationEvent): void {
  if (
    event.type === 'turn_start' ||
    event.type === 'turn_end' ||
    event.type === 'task' ||
    event.type === 'snapshot'
  )
    return;
  const activeEvent = event as ActiveEvent;
  const turnId = 'turnId' in activeEvent ? activeEvent.turnId : undefined;
  const turn = turnId ? activeTurns.get(conversationId)?.get(turnId) : undefined;
  if (!turn) return;
  if (activeEvent.type === 'assistant_delta' || activeEvent.type === 'reasoning_delta') {
    const existing = turn.events.findIndex(
      (item) => item.type === activeEvent.type && item.messageId === activeEvent.messageId
    );
    if (existing >= 0) {
      const previous = turn.events[existing] as typeof activeEvent;
      const otherText = turn.events.reduce(
        (total, item, index) => (index === existing ? total : total + eventTextSize(item)),
        0
      );
      const remaining = Math.max(0, MAX_ACTIVE_TEXT_PER_TURN - otherText);
      turn.events[existing] = {
        ...activeEvent,
        text: `${previous.text}${activeEvent.text}`.slice(
          0,
          Math.min(MAX_TEXT_PER_DELTA, remaining)
        ),
      };
      return;
    }
  } else if (activeEvent.type === 'tool_result') {
    const existing = turn.events.findIndex(
      (item) => item.type === 'tool_result' && item.toolCallId === activeEvent.toolCallId
    );
    if (existing >= 0) {
      const otherText = turn.events.reduce(
        (total, item, index) => (index === existing ? total : total + eventTextSize(item)),
        0
      );
      turn.events[existing] = boundEventText(
        activeEvent,
        Math.max(0, MAX_ACTIVE_TEXT_PER_TURN - otherText)
      );
      return;
    }
  }
  if (turn.events.length >= MAX_EVENTS_PER_TURN) {
    const replaceable = turn.events.findIndex(
      (item) => item.type === 'assistant_delta' || item.type === 'reasoning_delta'
    );
    if (replaceable >= 0) turn.events.splice(replaceable, 1);
    else return;
  }
  const used = turn.events.reduce((total, item) => total + eventTextSize(item), 0);
  const bounded = boundEventText(activeEvent, Math.max(0, MAX_ACTIVE_TEXT_PER_TURN - used));
  if (
    eventTextSize(bounded) > 0 ||
    (!('text' in activeEvent) && !('result' in activeEvent) && !('args' in activeEvent))
  )
    turn.events.push(bounded);
}

function eventTextSize(event: ActiveEvent): number {
  if ('text' in event) return event.text.length;
  if (event.type === 'tool_result') return (event.args?.length ?? 0) + event.result.length;
  return 0;
}

function boundEventText<T extends ActiveEvent>(event: T, max: number): T {
  if ('text' in event)
    return { ...event, text: event.text.slice(0, Math.min(max, MAX_TEXT_PER_DELTA)) } as T;
  if (event.type === 'tool_result') {
    const args = event.args?.slice(0, max);
    return {
      ...event,
      ...(args !== undefined ? { args } : {}),
      result: event.result.slice(0, Math.max(0, max - (args?.length ?? 0))),
    } as T;
  }
  return event;
}

function touch(conversationId: string): void {
  const now = Date.now();
  touched.delete(conversationId);
  touched.set(conversationId, now);
  for (const [id, time] of touched) {
    if (now - time > MAX_STATE_AGE_MS) clearState(id);
  }
  while (touched.size > MAX_STATES) {
    const oldest = touched.keys().next().value;
    if (!oldest) break;
    clearState(oldest);
  }
}

function clearState(conversationId: string): void {
  activeTurns.delete(conversationId);
  liveTasks.delete(conversationId);
  touched.delete(conversationId);
}

export function publishList(event: ConversationListEvent): void {
  hub.emit(LIST, event);
}

export function subscribeList(listener: (event: ConversationListEvent) => void): () => void {
  hub.on(LIST, listener);
  return () => hub.off(LIST, listener);
}

/** Drop retained snapshots and subscribers owned by the application context. */
export function closeEventHub(): void {
  activeTurns.clear();
  liveTasks.clear();
  touched.clear();
  hub.removeAllListeners();
}
