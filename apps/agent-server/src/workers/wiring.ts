import { consoleLogger, type Clock, type Logger, systemClock } from '@artemis/core';
import type { McpCatalog, McpClient } from '@artemis/mcp';
import type { Storage } from '@artemis/storage';
import type { AnyTool, Toolset } from '@artemis/tools';
import type { WorkspaceTransport } from '@artemis/workspace';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import type { TaskPort } from '../tools/task-port.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import type { TitleService } from '../titles/title-service.ts';
import { createAgentToolset, type AgentToolContext } from '../tools/index.ts';
import { WorkerSupervisor } from './supervisor.ts';

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
  /** `memory_search` / `memory_remember` (from `createMemoryTools`), appended after the MCP bridge. */
  memoryTools: readonly AnyTool<AgentToolContext>[];
  /** `ASSISTANT_PRESENT_TOOL`. */
  present: boolean;
  clock?: Clock;
  logger?: Logger;
}

/** The wired workers, tasks, delivery and toolset. Call `recover()` before `start()`. */
export interface AgentRuntime {
  supervisor: WorkerSupervisor;
  tasks: TaskPort;
  delivery: BackgroundDeliveryService;
  tools: Toolset<AgentToolContext>;
}

/**
 * Wiring of the worker side. The supervisor builds the delivery service, the task
 * service and the toolset over its own workers, so the cycle (workers -> tasks ->
 * workers, tools -> tasks) is one object graph built in one place, with no
 * late-bound closures.
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? consoleLogger('agent');
  const supervisor = new WorkerSupervisor(
    {
      config: deps.config,
      storage: deps.storage,
      router: deps.router,
      prompts: deps.prompts,
      subagents: deps.subagents,
      hub: deps.hub,
      memory: deps.memory,
      calls: deps.calls,
      titles: deps.titles,
      workspace: deps.workspace,
      catalog: deps.catalog,
      clock,
      logger,
    },
    (tasks) =>
      createAgentToolset({
        tasks,
        catalog: deps.catalog,
        mcp: deps.mcp,
        subagents: deps.subagents,
        backgroundAfterMs: deps.config.workers.backgroundAfterMs,
        present: deps.present,
        memoryTools: deps.memoryTools,
      })
  );
  return { supervisor, tasks: supervisor.taskService, delivery: supervisor.delivery, tools: supervisor.toolset };
}
