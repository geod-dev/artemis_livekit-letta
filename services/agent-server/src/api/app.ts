import { notImplemented } from '@artemis/core';
import type { Hono } from 'hono';
import type { BackgroundDeliveryService } from '../background/delivery.ts';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationService } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { TaskService } from '../tasks/task-service.ts';
import type { WorkerSupervisor } from '../workers/supervisor.ts';

export interface ApiDependencies {
  config: AgentServerConfig;
  conversations: ConversationService;
  supervisor: WorkerSupervisor;
  tasks: TaskService;
  delivery: BackgroundDeliveryService;
  calls: CallSessions;
  events: ConversationEventHub;
  ready: () => Promise<{ storage: boolean; mcp: boolean; memory: boolean }>;
}

/**
 * Hono app (routes: architecture.md#agent-server-api). Everything under `/v1`
 * requires `Bearer AGENT_SERVER_TOKEN`; `/health` and `/ready` are open.
 * Split by file: api/conversations.ts, api/voice.ts, api/mcp.ts.
 */
export function createApp(_deps: ApiDependencies): Hono {
  return notImplemented('createApp');
}
