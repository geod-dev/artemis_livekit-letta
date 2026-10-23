import type { Clock, Logger } from '@artemis/core';
import type { McpCatalog } from '@artemis/mcp';
import type { Storage } from '@artemis/storage';
import type { Toolset } from '@artemis/tools';
import type { WorkspaceAccessPolicy, WorkspaceTransport } from '@artemis/workspace';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import type { TitleService } from '../titles/title-service.ts';
import type { AgentToolContext } from '../tools/index.ts';
import type { TaskPort } from '../tools/task-port.ts';

/** The ports every worker runs on, as the composition root and the wiring provide them. */
export interface WorkerBase {
  config: AgentServerConfig;
  storage: Storage;
  router: ModelRouter;
  prompts: PromptRenderer;
  subagents: readonly SubagentDefinition[];
  hub: ConversationEventHub;
  memory: MemoryCoordinator;
  calls: CallSessions;
  titles: TitleService;
  workspace: WorkspaceTransport;
  catalog: McpCatalog;
  clock: Clock;
  logger: Logger;
}

/**
 * Everything a worker needs: the base ports plus the delivery, task port and toolset
 * the supervisor wires when it is built (it owns them; no late-bound getters).
 */
export interface WorkerEnv extends WorkerBase {
  delivery: BackgroundDeliveryService;
  tasks: TaskPort;
  tools: Toolset<AgentToolContext>;
}

export function workspaceAccess(config: AgentServerConfig): WorkspaceAccessPolicy {
  return { readOnlyPrefixes: config.workspace.readOnlyPrefixes };
}
