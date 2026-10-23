import type { Clock, Logger } from '@artemis/core';
import type { McpCatalog } from '@artemis/mcp';
import type { Storage } from '@artemis/storage';
import type { Toolset } from '@artemis/tools';
import type { WorkspaceAccessPolicy, WorkspaceTransport } from '@artemis/workspace';
import type { BackgroundDeliveryService } from '../background/delivery.ts';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import type { TaskService } from '../tasks/task-service.ts';
import type { TitleService } from '../titles/title-service.ts';
import type { AgentToolContext } from '../tools/index.ts';

/**
 * Everything a worker needs from the composition root. Services that depend on
 * the supervisor itself (tools, tasks) are read through getters: they are wired
 * after the workers' environment exists.
 */
export interface WorkerEnv {
  config: AgentServerConfig;
  storage: Storage;
  router: ModelRouter;
  prompts: PromptRenderer;
  subagents: readonly SubagentDefinition[];
  hub: ConversationEventHub;
  delivery: BackgroundDeliveryService;
  memory: MemoryCoordinator;
  calls: CallSessions;
  titles: TitleService;
  workspace: WorkspaceTransport;
  catalog: McpCatalog;
  tools: () => Toolset<AgentToolContext>;
  tasks: () => TaskService;
  clock: Clock;
  logger: Logger;
}

export function workspaceAccess(config: AgentServerConfig): WorkspaceAccessPolicy {
  return { readOnlyPrefixes: config.workspace.readOnlyPrefixes };
}
