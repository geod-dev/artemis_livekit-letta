import { EventEmitter } from 'node:events';
import type { ConversationEvent, ConversationListEvent, Modality } from '@artemis/contracts/chat-types';
import { type Clock, systemClock } from '@artemis/core';

/**
 * In-process pub/sub per conversation + the list channel (port of
 * backend/src/assistant/conversations/events.ts): retains in-flight turns and
 * running tasks to send a bounded `snapshot` first on subscribe (<= 4 turns,
 * <= 32 events/turn, <= 128 KB text/turn). Single-instance by design.
 */
type ActiveEvent = Exclude<ConversationEvent, { type: 'snapshot' }>;
type LiveTask = { taskId: string; status: 'running' | 'finished'; title: string };

interface ActiveTurn {
  turnId: string;
  modality: Modality;
  events: ActiveEvent[];
}

const MAX_STATES = 128;
const MAX_STATE_AGE_MS = 30 * 60_000;
const MAX_TURNS_PER_CONVERSATION = 4;
const MAX_TASKS_PER_CONVERSATION = 64;
const MAX_EVENTS_PER_TURN = 32;
const MAX_TEXT_PER_DELTA = 64 * 1024;
const MAX_ACTIVE_TEXT_PER_TURN = 128 * 1024;
const LIST = 'conversation-list';

export class ConversationEventHub {
  private readonly hub = new EventEmitter().setMaxListeners(0);
  private readonly activeTurns = new Map<string, Map<string, ActiveTurn>>();
  private readonly liveTasks = new Map<string, Map<string, LiveTask>>();
  private readonly touched = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  publish(conversationId: string, event: ConversationEvent): void {
    this.touch(conversationId);
    if (event.type === 'turn_start') {
      const turns = this.activeTurns.get(conversationId) ?? new Map<string, ActiveTurn>();
      if (turns.size >= MAX_TURNS_PER_CONVERSATION) turns.delete(firstKey(turns));
      turns.set(event.turnId, { turnId: event.turnId, modality: event.modality, events: [event] });
      this.activeTurns.set(conversationId, turns);
    } else if (event.type === 'turn_end') {
      const turns = this.activeTurns.get(conversationId);
      turns?.delete(event.turnId);
      if (!turns?.size) this.activeTurns.delete(conversationId);
    } else if (event.type === 'task') {
      const tasks = this.liveTasks.get(conversationId) ?? new Map<string, LiveTask>();
      if (event.status === 'finished') tasks.delete(event.taskId);
      else {
        if (tasks.size >= MAX_TASKS_PER_CONVERSATION) tasks.delete(firstKey(tasks));
        tasks.set(event.taskId, { taskId: event.taskId, status: event.status, title: event.title.slice(0, 500) });
      }
      if (tasks.size) this.liveTasks.set(conversationId, tasks);
      else this.liveTasks.delete(conversationId);
    }
    this.recordActiveEvent(conversationId, event);
    if (!this.activeTurns.has(conversationId) && !this.liveTasks.has(conversationId)) this.clearState(conversationId);
    this.hub.emit(conversationId, event);
  }

  /** Sends a `snapshot` first, then live events; returns unsubscribe. */
  subscribe(conversationId: string, listener: (event: ConversationEvent) => void): () => void {
    this.hub.on(conversationId, listener);
    const unsubscribe = () => this.hub.off(conversationId, listener);
    try {
      this.touch(conversationId);
      const turns = [...(this.activeTurns.get(conversationId)?.values() ?? [])];
      listener({
        type: 'snapshot',
        turns: turns.map(({ turnId, modality }) => ({ turnId, modality })),
        tasks: [...(this.liveTasks.get(conversationId)?.values() ?? [])],
        activeEvents: turns.flatMap((turn) => turn.events),
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  publishList(event: ConversationListEvent): void {
    this.hub.emit(LIST, event);
  }

  subscribeList(listener: (event: ConversationListEvent) => void): () => void {
    this.hub.on(LIST, listener);
    return () => this.hub.off(LIST, listener);
  }

  /** Forget retained state once a conversation is archived. */
  clear(conversationId: string): void {
    this.clearState(conversationId);
  }

  /** Drop retained snapshots and subscribers (shutdown). */
  close(): void {
    this.activeTurns.clear();
    this.liveTasks.clear();
    this.touched.clear();
    this.hub.removeAllListeners();
  }

  private recordActiveEvent(conversationId: string, event: ConversationEvent): void {
    if (event.type === 'turn_start' || event.type === 'turn_end' || event.type === 'task' || event.type === 'snapshot') return;
    const activeEvent = event as ActiveEvent;
    const turnId = 'turnId' in activeEvent ? activeEvent.turnId : undefined;
    const turn = turnId ? this.activeTurns.get(conversationId)?.get(turnId) : undefined;
    if (!turn) return;
    if (activeEvent.type === 'assistant_delta' || activeEvent.type === 'reasoning_delta') {
      const existing = turn.events.findIndex((item) => item.type === activeEvent.type && item.messageId === activeEvent.messageId);
      if (existing >= 0) {
        const previous = turn.events[existing] as typeof activeEvent;
        const remaining = Math.max(0, MAX_ACTIVE_TEXT_PER_TURN - this.otherTextSize(turn, existing));
        turn.events[existing] = {
          ...activeEvent,
          text: `${previous.text}${activeEvent.text}`.slice(0, Math.min(MAX_TEXT_PER_DELTA, remaining)),
        };
        return;
      }
    } else if (activeEvent.type === 'tool_result') {
      const existing = turn.events.findIndex((item) => item.type === 'tool_result' && item.toolCallId === activeEvent.toolCallId);
      if (existing >= 0) {
        turn.events[existing] = boundEventText(activeEvent, Math.max(0, MAX_ACTIVE_TEXT_PER_TURN - this.otherTextSize(turn, existing)));
        return;
      }
    }
    if (turn.events.length >= MAX_EVENTS_PER_TURN) {
      const replaceable = turn.events.findIndex((item) => item.type === 'assistant_delta' || item.type === 'reasoning_delta');
      if (replaceable < 0) return;
      turn.events.splice(replaceable, 1);
    }
    const used = turn.events.reduce((total, item) => total + eventTextSize(item), 0);
    const bounded = boundEventText(activeEvent, Math.max(0, MAX_ACTIVE_TEXT_PER_TURN - used));
    const carriesText = 'text' in activeEvent || 'result' in activeEvent || 'args' in activeEvent;
    if (eventTextSize(bounded) > 0 || !carriesText) turn.events.push(bounded);
  }

  private otherTextSize(turn: ActiveTurn, skipIndex: number): number {
    return turn.events.reduce((total, item, index) => (index === skipIndex ? total : total + eventTextSize(item)), 0);
  }

  private touch(conversationId: string): void {
    const now = this.clock.now();
    this.touched.delete(conversationId);
    this.touched.set(conversationId, now);
    for (const [id, time] of this.touched) {
      if (now - time > MAX_STATE_AGE_MS) this.clearState(id);
    }
    while (this.touched.size > MAX_STATES) {
      const oldest = firstKey(this.touched);
      if (oldest === undefined) break;
      this.clearState(oldest);
    }
  }

  private clearState(conversationId: string): void {
    this.activeTurns.delete(conversationId);
    this.liveTasks.delete(conversationId);
    this.touched.delete(conversationId);
  }
}

function firstKey<K, V>(map: Map<K, V>): K {
  return map.keys().next().value as K;
}

function eventTextSize(event: ActiveEvent): number {
  if ('text' in event) return event.text.length;
  if (event.type === 'tool_result') return (event.args?.length ?? 0) + event.result.length;
  return 0;
}

function boundEventText<T extends ActiveEvent>(event: T, max: number): T {
  if ('text' in event) return { ...event, text: event.text.slice(0, Math.min(max, MAX_TEXT_PER_DELTA)) } as T;
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
