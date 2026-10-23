import type { Clock } from '@artemis/core';
import type { McpServerRegistry } from '@artemis/mcp';
import type { BackgroundDeliveryService } from '../background/delivery.ts';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationService } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { TaskService } from '../tasks/task-service.ts';

/** What the HTTP routes receive. Turns go through `conversations`; routes never reach the workers. */
export interface ApiDependencies {
  config: AgentServerConfig;
  conversations: ConversationService;
  tasks: TaskService;
  delivery: BackgroundDeliveryService;
  calls: CallSessions;
  events: ConversationEventHub;
  mcp: McpServerRegistry;
  clock: Clock;
  /** Component readiness for `GET /ready` (memory is optional: it only degrades readiness). */
  ready: () => Promise<{ storage: boolean; mcp: boolean; memory: boolean }>;
}
