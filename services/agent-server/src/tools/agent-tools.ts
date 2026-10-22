import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { JsonSchema } from '@artemis/llm';
import { capText, errorResult, TOOL_NAMES, Tool, textResult, type ToolResult } from '@artemis/tools';
import { validatePresentTree } from '../../../../shared/present-validation.ts';
import presentComponents from '../../../../shared/generated/present-components.json' with { type: 'json' };
import presentTool from '../../../../shared/generated/present-tool.json' with { type: 'json' };
import type { SubagentSpec } from '../workers/types.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import type { AgentToolContext } from './index.ts';

const RESULT_CAP_HINT = 'ask for a shorter report or read the full output in the workspace';

interface RunAgentInput {
  subagent_type: string;
  description: string;
  prompt: string;
  resume_task_id?: string;
}

/**
 * `run_agent`. Interactive policy: starts a background task and returns its id
 * (the report arrives later as an update). Synchronous policy (inside a
 * subagent): runs the nested subagent and returns its report.
 */
export class RunAgentTool extends Tool<RunAgentInput, AgentToolContext> {
  readonly name = TOOL_NAMES.runAgent;
  readonly description =
    'Delegate a self-contained piece of work to a subagent that has the same tools as you. In the main conversation it runs in the background as a task: you get its report as a background update when it finishes, so do not poll. Inside a subagent it runs to completion and returns its report. resume_task_id continues an earlier subagent task with its transcript.';
  readonly inputSchema: JsonSchema;

  constructor(definitions: readonly SubagentDefinition[]) {
    super();
    this.inputSchema = {
      type: 'object',
      properties: {
        subagent_type: {
          type: 'string',
          enum: definitions.map((definition) => definition.name),
          description: definitions.map((definition) => `${definition.name}: ${definition.description}`).join(' | '),
        },
        description: { type: 'string', minLength: 1, description: 'Short title shown in the UI.' },
        prompt: { type: 'string', minLength: 1, description: 'Complete assignment: the subagent sees nothing else.' },
        resume_task_id: { type: 'string', minLength: 1, description: 'Continue this earlier subagent task.' },
      },
      required: ['subagent_type', 'description', 'prompt'],
      additionalProperties: false,
    };
  }

  async execute(input: RunAgentInput, ctx: AgentToolContext): Promise<ToolResult> {
    const spec: SubagentSpec = {
      conversationId: ctx.conversationId,
      subagentType: input.subagent_type,
      title: input.description,
      prompt: input.prompt,
      originMode: ctx.mode,
      originTurnId: ctx.turnId,
      originToolCallId: ctx.toolCallId,
      parentTaskId: ctx.taskId,
      resumedFromTaskId: input.resume_task_id ?? null,
      depth: ctx.taskDepth,
    };
    const base = {
      subagentType: input.subagent_type,
      title: input.description,
      prompt: input.prompt,
      ...(input.resume_task_id ? { resumedFromTaskId: input.resume_task_id } : {}),
    };

    if (ctx.policy === 'synchronous') {
      const run = await ctx.tasks.runSubagent(spec, ctx.signal);
      const text = run.report.trim() || 'The subagent produced no report.';
      return {
        content: [{ type: 'text', text: capText(text, RESULT_CAP_HINT) }],
        isError: run.status !== 'completed',
        display: { type: 'agent', taskId: run.taskId, synchronous: true, ...base },
        task: { taskId: run.taskId, kind: 'agent', relation: 'started', title: input.description },
      };
    }

    const started = await ctx.tasks.startSubagent(spec);
    return textResult(
      `Started background task ${started.taskId} (${input.subagent_type}). You will get a background update when it finishes; do not poll.`,
      {
        display: { type: 'agent', taskId: started.taskId, ...base },
        task: { taskId: started.taskId, kind: 'agent', relation: 'started', title: input.description },
      }
    );
  }
}

/** `list_tasks`: the conversation's tasks, newest first. */
export class ListTasksTool extends Tool<Record<string, never>, AgentToolContext> {
  readonly name = TOOL_NAMES.listTasks;
  readonly description = 'List the tasks of this conversation (subagents and background commands) with their status.';
  readonly inputSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
  override readonly readOnly = true;

  async execute(_input: Record<string, never>, ctx: AgentToolContext): Promise<ToolResult> {
    const tasks = await ctx.tasks.list(ctx.conversationId);
    const lines = tasks.map((task) => `- ${task.id} [${task.status}] ${task.kind ?? 'task'}: ${task.title}`);
    return textResult(lines.length ? lines.join('\n') : 'No tasks in this conversation.', {
      display: { type: 'task', operation: 'list', taskIds: tasks.map((task) => task.id) },
    });
  }
}

/** `get_task`: status, report and output tail of one task. */
export class GetTaskTool extends Tool<{ task_id: string }, AgentToolContext> {
  readonly name = TOOL_NAMES.getTask;
  readonly description = 'Show one task of this conversation: status, report and the tail of its output. The full command log is at output_path.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: { task_id: { type: 'string', minLength: 1 } },
    required: ['task_id'],
    additionalProperties: false,
  };
  override readonly readOnly = true;

  async execute(input: { task_id: string }, ctx: AgentToolContext): Promise<ToolResult> {
    const task = await ctx.tasks.get(ctx.conversationId, input.task_id);
    if (!task) return errorResult(`No task ${input.task_id} in this conversation.`);
    const lines = [`Task ${task.id}: ${task.title}`, `Status: ${task.status}`];
    if (task.exitCode !== undefined && task.exitCode !== null) lines.push(`Exit code: ${task.exitCode}`);
    if (task.outputPath) lines.push(`Output: ${task.outputPath}`);
    if (task.report) lines.push(`Report:\n${task.report}`);
    if (task.stdout?.trim()) lines.push(`stdout (tail):\n${task.stdout}`);
    if (task.stderr?.trim()) lines.push(`stderr (tail):\n${task.stderr}`);
    return textResult(capText(lines.join('\n'), RESULT_CAP_HINT), {
      display: { type: 'task', operation: 'get', taskIds: [task.id] },
      task: { taskId: task.id, kind: task.kind ?? 'agent', relation: 'inspected', title: task.title },
    });
  }
}

/** `stop_task`: asks a running task to stop (it ends `cancelled`). */
export class StopTaskTool extends Tool<{ task_id: string }, AgentToolContext> {
  readonly name = TOOL_NAMES.stopTask;
  readonly description = 'Stop a running task of this conversation. It ends as cancelled and its update is delivered like any other.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: { task_id: { type: 'string', minLength: 1 } },
    required: ['task_id'],
    additionalProperties: false,
  };

  async execute(input: { task_id: string }, ctx: AgentToolContext): Promise<ToolResult> {
    const stopped = await ctx.tasks.stop(ctx.conversationId, input.task_id);
    if (!stopped) return errorResult(`Task ${input.task_id} is not running in this conversation.`);
    return textResult(`Stop requested for task ${input.task_id}.`, {
      display: { type: 'task', operation: 'stop', taskIds: [input.task_id] },
      task: { taskId: input.task_id, kind: 'agent', relation: 'stopped' },
    });
  }
}

/**
 * `present`: generative UI. Validated against the shared present protocol
 * (bounds, component names and each component's props, via the generated
 * per-component JSON schemas). Advertised only when `ASSISTANT_PRESENT_TOOL=true`.
 */
const presentAjv = new Ajv2020({ allowUnionTypes: true });
const presentValidators = new Map<string, ValidateFunction>(
  Object.entries(presentComponents).map(([name, schema]) => [name, presentAjv.compile(schema as object)]),
);

export class PresentTool extends Tool<Record<string, unknown>, AgentToolContext> {
  readonly name = TOOL_NAMES.present;
  readonly description = presentTool.description;
  readonly inputSchema = presentTool.parameters as JsonSchema;

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const components = [...presentValidators.keys()];
    const result = validatePresentTree(input, (type, props) => presentValidators.get(type)?.(props) === true);
    if (!result.ok) {
      return errorResult(`Not shown: ${result.error} Use only these components: ${components.join(', ')}.`);
    }
    return textResult('Shown to the user in the chat.', { display: { type: 'present' } });
  }
}

/** `set_call_mode`: keeps a voice call short or long. Fails outside calls. */
export class SetCallModeTool extends Tool<{ mode: 'short' | 'long' }, AgentToolContext> {
  readonly name = TOOL_NAMES.setCallMode;
  readonly description = 'Set how the current voice call continues: short (ends after this answer) or long (stays open until ended). Only during a voice call.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['short', 'long'] } },
    required: ['mode'],
    additionalProperties: false,
  };

  async execute(input: { mode: 'short' | 'long' }, ctx: AgentToolContext): Promise<ToolResult> {
    if (!ctx.calls.setMode(ctx.conversationId, input.mode)) return errorResult('No voice call is active.');
    return textResult(`Call mode set to ${input.mode}.`, { display: { type: 'call', action: 'set_mode', mode: input.mode } });
  }
}

/** `end_call`: ends the current voice call after this answer. Fails outside calls. */
export class EndCallTool extends Tool<Record<string, never>, AgentToolContext> {
  readonly name = TOOL_NAMES.endCall;
  readonly description = 'End the current voice call after your spoken answer. Only during a voice call.';
  readonly inputSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

  async execute(_input: Record<string, never>, ctx: AgentToolContext): Promise<ToolResult> {
    if (!ctx.calls.requestEnd(ctx.conversationId)) return errorResult('No voice call is active.');
    return textResult('The call ends after this answer.', { display: { type: 'call', action: 'end' } });
  }
}
