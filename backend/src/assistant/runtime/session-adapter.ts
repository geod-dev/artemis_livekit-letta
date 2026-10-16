import type {
  AnyAgentTool,
  LettaCodeSession,
  SDKMessage,
  SDKQueueItem,
} from '@letta-ai/letta-agent-sdk';
import { randomUUID } from 'node:crypto';
import { receiveNotifications } from '../background/service.ts';
import { extractTaskNotifications } from '../background/task-notifications.ts';
import { lettaContextTokens, recordLettaContextUsage } from '../conversations/context-usage.ts';
import { publish } from '../conversations/events.ts';
import { assistant } from '../letta/agent-client.ts';
import { NativeTurn } from './native-turn';

const MAX_READER_MESSAGES = 512;
const MAX_CLAIMED_NOTIFICATIONS = 2048;

/** Cancel a local wait even when a remote provider fails to acknowledge abort. */
export function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Reads a session's stream continuously and hands messages to the turn being
 * run. Letta also emits messages outside the gateway's turns (queue updates,
 * turns it starts or cancels on its own, e.g. a notification turn handed to
 * the gateway). App-owned turns go to their executor; autonomous turns are
 * projected to the conversation's live event stream instead of being dropped.
 */
export class SessionReader {
  private sink: ((message: SDKMessage | null) => void) | null = null;
  private claimed = new Set<string>();
  private terminal: SDKMessage | null = null;
  private overflowed = false;
  private readonly native: NativeTurn;

  constructor(
    private readonly session: LettaCodeSession,
    private readonly conversationId: string,
    private readonly ports: {
      receiveNotifications: typeof receiveNotifications;
      publish?: typeof publish;
      onNativeTool?: ConstructorParameters<typeof NativeTurn>[1];
    } = {
      receiveNotifications,
    }
  ) {
    this.native = new NativeTurn(
      (event) => (ports.publish ?? publish)(conversationId, event),
      ports.onNativeTool
    );
    void this.pump();
  }

  get nativeTurnActive(): boolean {
    return this.native.active;
  }

  /** The messages of the next turn, up to its result. Call before sending the turn. */
  nextTurn(signal?: AbortSignal): AsyncIterable<SDKMessage> {
    this.overflowed = false;
    const getTerminal = () => this.terminal;
    const queue: (SDKMessage | null)[] = [];
    let wake: (() => void) | null = null;
    const sink = (message: SDKMessage | null) => {
      if (this.overflowed) return;
      if (message === null) {
        this.terminal = {
          type: 'result',
          success: false,
          errorCode: 'stream_closed',
        } as SDKMessage;
      }
      if (queue.length >= MAX_READER_MESSAGES) {
        this.overflowed = true;
        queue.length = 0;
        queue.push({
          type: 'result',
          success: false,
          error: 'session reader buffer limit reached',
        } as SDKMessage);
        wake?.();
        return;
      }
      queue.push(message);
      wake?.();
    };
    this.sink = sink;
    const abort = () => {
      queue.length = 0;
      queue.push({ type: 'result', success: false, error: 'aborted' } as SDKMessage);
      wake?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const release = () => {
      signal?.removeEventListener('abort', abort);
      if (this.sink === sink) this.sink = null;
    };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            if (queue.length === 0) {
              const terminal = getTerminal();
              if (terminal) {
                yield terminal;
                return;
              }
            }
            if (queue.length === 0)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            wake = null;
            const message = queue.shift();
            if (message === undefined) continue;
            if (message === null) {
              yield { type: 'result', success: false, errorCode: 'stream_closed' } as SDKMessage;
              return;
            }
            yield message;
            if (message.type === 'result') return;
          }
        } finally {
          release();
        }
      },
    };
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        let received = 0;
        for await (const message of this.session.stream()) {
          received++;
          const contextTokens = lettaContextTokens(message);
          if (contextTokens !== undefined)
            await recordLettaContextUsage(this.conversationId, contextTokens);
          if (message.type === 'queue_update') this.claimNotifications(message.queue);
          if (this.sink) {
            const sink = this.sink;
            // Release ownership at the protocol boundary, before the consumer
            // resumes: another native turn may already be queued by the SDK.
            if (message.type === 'result') this.sink = null;
            sink(message);
          } else await this.native.accept(message);
        }
        if (received === 0) break;
      }
    } catch (error) {
      console.warn(`[assistant] session stream failed in ${this.conversationId}:`, error);
    } finally {
      this.native.finish(false, 'stream_closed');
      this.terminal = { type: 'result', success: false, errorCode: 'stream_closed' } as SDKMessage;
      this.sink?.(null);
    }
  }

  /**
   * Letta merges notifications queued during a turn into that turn's next tool
   * continuation, which mod `turn_start` handlers never see. Remove a still
   * queued notification before handing it to the gateway; if Letta already
   * consumed it, leave delivery to Letta so only one assistant turn runs.
   */
  private claimNotifications(queue: readonly SDKQueueItem[]): void {
    for (const item of queue) {
      if (item.kind !== 'task_notification' || this.claimed.has(item.id)) continue;
      const text = typeof item.content === 'string' ? item.content : contentText(item.content);
      const parsed = extractTaskNotifications(text);
      const blocks = text.match(/<task-notification>/g)?.length ?? 0;
      if (!parsed.notifications.length || blocks !== parsed.notifications.length) continue;
      if (this.claimed.size >= MAX_CLAIMED_NOTIFICATIONS) this.claimed.clear();
      this.claimed.add(item.id);
      void this.session
        .removeQueuedMessage(item.id)
        .then(({ removed }) => {
          // A missing queue item may only have been dequeued: turn_start can
          // still hand it to the gateway. Recording it as delivered here makes
          // that callback a duplicate, so the mod cancels the native turn and
          // nobody wakes the assistant. Only accept work we actually own.
          if (!removed) return;
          return this.ports.receiveNotifications(this.conversationId, [text]);
        })
        .catch((error: unknown) => {
          this.claimed.delete(item.id);
          console.warn(`[assistant] could not claim queued notification ${item.id}:`, error);
        });
    }
  }
}

function contentText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
    : '';
}

/** Let a turn Letta is running on its own settle before sending one (bounded wait). */
export async function waitUntilIdle(
  session: LettaCodeSession,
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted while waiting for conversation');
    let status;
    try {
      const remaining = deadline - Date.now();
      const request = session.getDeviceStatus({ timeoutMs: Math.min(5_000, remaining) });
      status = await new Promise<Awaited<typeof request>>((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(new Error('aborted while waiting for conversation'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('conversation busy: idle wait deadline exceeded'));
        }, remaining);
        signal?.addEventListener('abort', abort, { once: true });
        request
          .then(resolve, reject)
          .finally(cleanup)
          .catch(() => undefined);
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('aborted while waiting for conversation');
      if (
        error instanceof Error &&
        error.message === 'conversation busy: idle wait deadline exceeded'
      )
        throw error;
      throw new Error(
        `conversation status unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!status.isProcessing) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, 200);
      function done() {
        signal?.removeEventListener('abort', abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(new Error('aborted while waiting for conversation'));
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error('conversation busy: idle wait deadline exceeded');
}

/**
 * The SDK registers client tools with Letta's default `auto_background`, which
 * hands any call that runs >10s to a later task notification. Client tools are
 * quick actions whose outcome belongs in the current response, so re-publish
 * the same definitions (same connection, same handlers) with inline waiting.
 * Longer work goes to Letta's native background workers instead.
 */
export async function registerToolsInline(
  session: LettaCodeSession,
  tools: AnyAgentTool[],
  conversationId: string
): Promise<void> {
  const { agentId } = await assistant();
  await session.sendCommand(
    {
      type: 'runtime_external_tools_update',
      request_id: randomUUID(),
      updates: [
        {
          runtimes: [{ agent_id: agentId, conversation_id: conversationId }],
          external_tools: [
            {
              tools: tools.map((tool) => ({
                name: tool.name,
                label: tool.label,
                description: tool.description,
                parameters: tool.parameters,
                auto_background: false,
                // The Letta client has a 120-second absolute command deadline.
                timeout_ms: 120_000,
              })),
            },
          ],
        },
      ],
    },
    { responseType: 'runtime_external_tools_update_response', timeoutMs: 15_000 }
  );
}
