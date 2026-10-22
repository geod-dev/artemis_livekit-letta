import { notImplemented } from '@artemis/core';
import type { TurnMode } from '@artemis/contracts/chat-types';
import type { ToolContext, Toolset } from '@artemis/tools';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { TaskService } from '../tasks/task-service.ts';

/** Context of agent-server tools: generic context + conversation services. */
export interface AgentToolContext extends ToolContext {
  /** Mode of the turn (or of the task's origin turn). */
  mode: TurnMode;
  /** Depth assigned to tasks this call starts (see `depthAfter`). */
  taskDepth: number;
  tasks: TaskService;
  calls: CallSessions;
}

/**
 * The single toolset of main agents AND subagents, in `TOOL_NAMES` order:
 * workspace tools (@artemis/tools), `run_agent` / `list_tasks` / `get_task` /
 * `stop_task`, `present`, `set_call_mode`, `end_call`, then the MCP bridge
 * (@artemis/mcp). Behaviour differences come from `context.policy` only:
 * - `run_agent {subagent_type, description, prompt, resume_task_id?}`:
 *   interactive -> background task, returns its id (`task.relation:'started'`);
 *   synchronous -> runs nested and returns the report.
 * - `present`: validated with shared/present-validation.ts; advertised only when
 *   `ASSISTANT_PRESENT_TOOL=true` at conversation creation (default off, as today).
 * - call tools fail with "No voice call is active" outside calls.
 */
export function createAgentToolset(_deps: { tasks: TaskService; calls: CallSessions }): Toolset<AgentToolContext> {
  return notImplemented('createAgentToolset');
}
