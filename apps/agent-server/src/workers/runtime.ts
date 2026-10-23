import { type Clock, consoleLogger, type Logger, systemClock } from '@artemis/core';
import type { McpCatalog, McpClient } from '@artemis/mcp';
import type { Storage } from '@artemis/storage';
import type { AnyTool, Toolset } from '@artemis/tools';
import type { WorkspaceTransport } from '@artemis/workspace';
import { StorageBackgroundDeliveryService, type BackgroundDeliveryService } from '../background/delivery.ts';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import { WorkerTaskService, type TaskService } from '../tasks/task-service.ts';
import type { TitleService } from '../titles/title-service.ts';
import { createAgentToolset, type AgentToolContext } from '../tools/index.ts';
import { WorkerSupervisor } from './supervisor.ts';
import type { WorkerEnv } from './env.ts';

interface AgentRuntimeDeps {
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
  mcp: McpClient;
  /** `memory_search` / `memory_remember` (WP-10 factory output), appended after the MCP bridge. */
  memoryTools: readonly AnyTool<AgentToolContext>[];
  /** `ASSISTANT_PRESENT_TOOL`. */
  present: boolean;
  clock?: Clock;
  logger?: Logger;
}

/** The wired workers, tasks, delivery and toolset. Call `recover()` before `start()`. */
export interface AgentRuntime {
  supervisor: WorkerSupervisor;
  tasks: TaskService;
  delivery: BackgroundDeliveryService;
  tools: Toolset<AgentToolContext>;
  env: WorkerEnv;
}

/**
 * Composition of the worker side. The supervisor, the task service, the
 * delivery service and the toolset refer to each other; the cycle is closed
 * through closures that are read only after construction.
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? consoleLogger('agent');
  let supervisor: WorkerSupervisor | undefined;
  let tasks: TaskService | undefined;
  let tools: Toolset<AgentToolContext> | undefined;

  const delivery = new StorageBackgroundDeliveryService({
    storage: deps.storage,
    hub: deps.hub,
    calls: deps.calls,
    clock,
    logger,
    wake: (conversationId) => supervisor?.wake(conversationId),
  });
  const env: WorkerEnv = {
    config: deps.config,
    storage: deps.storage,
    router: deps.router,
    prompts: deps.prompts,
    subagents: deps.subagents,
    hub: deps.hub,
    delivery,
    memory: deps.memory,
    calls: deps.calls,
    titles: deps.titles,
    workspace: deps.workspace,
    catalog: deps.catalog,
    tools: () => requireReady(tools, 'toolset'),
    tasks: () => requireReady(tasks, 'task service'),
    clock,
    logger,
  };
  const sup = new WorkerSupervisor(env);
  supervisor = sup;
  const taskService = new WorkerTaskService(env, sup);
  tasks = taskService;
  tools = createAgentToolset({
    tasks: taskService,
    catalog: deps.catalog,
    mcp: deps.mcp,
    subagents: deps.subagents,
    backgroundAfterMs: deps.config.workers.backgroundAfterMs,
    present: deps.present,
    memoryTools: deps.memoryTools,
  });
  return { supervisor: sup, tasks: taskService, delivery, tools, env };
}

function requireReady<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The agent runtime is not wired yet: ${what} is missing`);
  return value;
}
