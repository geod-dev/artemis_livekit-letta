import type { Clock, Logger } from '@artemis/core';
import type { McpServerRegistry } from '@artemis/mcp';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { VoiceService } from '../calls/voice-service.ts';
import type { ConversationService } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import type { TaskPort } from '../tools/task-port.ts';

/**
 * Everything the HTTP app is built from (`createApp`). Each route module takes only the
 * ports it uses (its own `*RouteDeps`); turns go through `conversations` and `voice`, and
 * routes never reach the workers.
 */
export interface ApiDependencies {
  /** The bearer token every `/v1` request must present (`AGENT_SERVER_TOKEN`). */
  token: string;
  conversations: ConversationService;
  tasks: TaskPort;
  delivery: BackgroundDeliveryService;
  calls: CallSessions;
  voice: VoiceService;
  events: ConversationEventHub;
  mcp: McpServerRegistry;
  clock: Clock;
  logger: Logger;
  /** Component readiness for `GET /ready` (memory is optional: it only degrades readiness). */
  ready: () => Promise<{ storage: boolean; mcp: boolean; memory: boolean }>;
}
