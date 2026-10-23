import type { TextEffort, TurnMode } from '@artemis/contracts/chat-types';
import type { McpClient, McpCatalog } from '@artemis/mcp';
import { createMcpBridgeTools } from '@artemis/mcp';
import { type AnyTool, type ToolContext, Toolset } from '@artemis/tools';
import { createWorkspaceTools } from '@artemis/tools/workspace-tools';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import type { TaskService } from '../tasks/task-service.ts';
import { EndCallTool, GetTaskTool, ListTasksTool, PresentTool, RunAgentTool, SetCallModeTool, StopTaskTool } from './agent-tools.ts';

/** Context of agent-server tools: generic context + conversation services. */
export interface AgentToolContext extends ToolContext {
  /** Mode of the turn (or of the task's origin turn). */
  mode: TurnMode;
  /** Effort of the turn (memory tools pick their default budget from it). */
  effort?: TextEffort | null;
  /** Depth assigned to tasks this call starts (see `depthAfter`). */
  taskDepth: number;
  tasks: TaskService;
  calls: CallSessions;
}

interface AgentToolsetDeps {
  tasks: TaskService;
  catalog: McpCatalog;
  mcp: McpClient;
  subagents: readonly SubagentDefinition[];
  /** Foreground bash -> background delay (`BASH_BACKGROUND_AFTER_MS`). */
  backgroundAfterMs: number;
  /** `ASSISTANT_PRESENT_TOOL`: the `present` tool is part of the toolset only when on. */
  present: boolean;
  /** `memory_search` / `memory_remember` from the memory tools factory (WP-10), in their order. */
  memoryTools: readonly AnyTool<AgentToolContext>[];
}

/**
 * The single toolset of main agents AND subagents, in `TOOL_NAMES` order (the
 * order is part of the cached prompt prefix; new tools are appended):
 * workspace tools, `run_agent` / `list_tasks` / `get_task` / `stop_task`,
 * `present` (optional), `set_call_mode` / `end_call`, the MCP bridge, memory tools.
 * Behaviour differences come from `context.policy` only (see `RunAgentTool`).
 * Call tools fail with "No voice call is active." outside calls.
 */
export function createAgentToolset(deps: AgentToolsetDeps): Toolset<AgentToolContext> {
  const tools: AnyTool<AgentToolContext>[] = [
    ...createWorkspaceTools({ handoff: deps.tasks, backgroundAfterMs: deps.backgroundAfterMs }),
    new RunAgentTool(deps.subagents),
    new ListTasksTool(),
    new GetTaskTool(),
    new StopTaskTool(),
    ...(deps.present ? [new PresentTool()] : []),
    new SetCallModeTool(),
    new EndCallTool(),
    ...createMcpBridgeTools(deps.catalog, deps.mcp),
    ...deps.memoryTools,
  ];
  return new Toolset<AgentToolContext>(tools);
}
