import type { ProcessExit, WorkspaceProcess } from '@artemis/workspace';
import type { ToolContext } from '../context.ts';
import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS, TOOL_NAMES } from '../names.ts';
import { errorResult, MAX_TOOL_TEXT, type ToolResult } from '../result.ts';
import { Tool } from '../tool.ts';
import type { CommandHandoff } from './types.ts';

/** Head of the output the model sees when the full output is cut (the rest is in the log). */
const HEAD_CHARS = 2_000;
const LOG_DIRECTORY = 'data/command-logs';

export interface BashInput {
  command: string;
  description: string;
  timeout_ms?: number;
  run_in_background?: boolean;
}

interface BashOptions {
  handoff: CommandHandoff;
  backgroundAfterMs: number;
}

type Outcome = { kind: 'exit'; exit: ProcessExit } | { kind: 'timer' } | { kind: 'abort' };

/**
 * Runs a shell command in the workspace.
 *
 * - interactive (main agent): wait up to `backgroundAfterMs`; a command still
 *   running then moves to a background task (`CommandHandoff.adopt`) on the same
 *   process, so its output is not lost. `run_in_background` adopts at once.
 * - synchronous (subagent): wait up to `timeout_ms` (killed afterwards); never hands off.
 *
 * An abort (turn cancelled) kills a foreground command; a handed-off one is left alone.
 */
export class BashTool extends Tool<BashInput> {
  readonly name = TOOL_NAMES.bash;
  readonly description =
    'Run a shell command in the workspace (bash -lc, working directory: the workspace root). A foreground command still running after about 10 seconds moves to the background as a task: you then get a background update when it finishes, so do not poll. run_in_background starts a command in the background at once. Inside a subagent, commands run to completion and timeout_ms (default 120000, max 600000) bounds them.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'Shell command line.' },
      description: { type: 'string', minLength: 1, description: 'Short description shown in the UI.' },
      timeout_ms: {
        type: 'integer',
        minimum: 1_000,
        maximum: MAX_BASH_TIMEOUT_MS,
        description: 'Synchronous runs only: kill after this many milliseconds.',
      },
      run_in_background: { type: 'boolean', description: 'Start in the background now (main agent only).' },
    },
    required: ['command', 'description'],
    additionalProperties: false,
  };

  constructor(private readonly options: BashOptions) {
    super();
  }

  async execute(input: BashInput, ctx: ToolContext): Promise<ToolResult> {
    const synchronous = ctx.policy === 'synchronous';
    if (synchronous && input.run_in_background) {
      return errorResult('run_in_background is not available inside a subagent; run the command in the foreground.');
    }
    const timeoutMs = synchronous ? Math.min(input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS) : undefined;

    let handle: WorkspaceProcess;
    try {
      handle = await ctx.workspace.spawn({ command: input.command, timeoutMs });
    } catch (error) {
      return errorResult(`Could not start the command: ${messageOf(error)}`, { display: commandDisplay(input) });
    }
    if (input.run_in_background) return this.hand(handle, input, ctx, 'requested');

    const outcome = await settleOrTimeout(handle, synchronous ? null : this.options.backgroundAfterMs, ctx.signal);
    if (outcome.kind === 'exit') return this.finished(handle, outcome.exit, input, ctx);
    if (outcome.kind === 'abort') {
      const exit = await handle.kill();
      return this.finished(handle, exit, input, ctx, 'Interrupted by user.');
    }
    // Timer: the command may have just finished; only a live process moves to the background.
    if (!handle.running) return this.finished(handle, await handle.exited, input, ctx);
    return this.hand(handle, input, ctx, 'handoff');
  }

  private async hand(
    handle: WorkspaceProcess,
    input: BashInput,
    ctx: ToolContext,
    reason: 'requested' | 'handoff'
  ): Promise<ToolResult> {
    let adopted: { taskId: string; outputPath: string };
    try {
      adopted = await this.options.handoff.adopt({
        process: handle,
        command: input.command,
        description: input.description,
        cwd: '.',
        reason,
        context: ctx,
      });
    } catch (error) {
      await handle.kill();
      return errorResult(`Could not move the command to the background: ${messageOf(error)}`, {
        display: commandDisplay(input),
      });
    }
    const { taskId, outputPath } = adopted;
    const started = reason === 'requested' ? 'started' : 'is still running';
    return {
      content: [
        {
          type: 'text',
          text: `Command ${started} in the background as task ${taskId} (log: ${outputPath}). You will get a background update when it finishes; do not poll.`,
        },
      ],
      isError: false,
      display: { ...commandDisplay(input), background: { taskId, reason }, outputPath },
      task: { taskId, kind: 'command', relation: reason === 'requested' ? 'started' : 'backgrounded', title: input.description },
      backgrounded: reason === 'handoff',
    };
  }

  /** Result of a command that ended (or was killed) in the foreground. */
  private async finished(
    handle: WorkspaceProcess,
    exit: ProcessExit,
    input: BashInput,
    ctx: ToolContext,
    interrupted?: string
  ): Promise<ToolResult> {
    let stdout = '';
    let stderr = '';
    for await (const chunk of handle.output()) {
      if (chunk.stream === 'stdout') stdout += chunk.text;
      else stderr += chunk.text;
    }
    const status = interrupted
      ? interrupted
      : exit.timedOut
        ? `Timed out and was killed (timeout_ms ${input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS}).`
        : exit.exitCode !== null
          ? `Exit code: ${exit.exitCode}.`
          : `Terminated by ${exit.signal ?? 'a signal'}.`;
    const parts = [status];
    if (stdout.trim()) parts.push(`stdout:\n${stdout.replace(/\n$/, '')}`);
    if (stderr.trim()) parts.push(`stderr:\n${stderr.replace(/\n$/, '')}`);
    const full = parts.join('\n');

    let text = full;
    let logPath: string | undefined;
    if (full.length > MAX_TOOL_TEXT) {
      const path = `${LOG_DIRECTORY}/${safeFileName(ctx.toolCallId)}.log`;
      try {
        await ctx.workspace.writeFile(path, full);
        logPath = path;
      } catch {
        logPath = undefined;
      }
      const where = logPath ? `; full output: ${logPath}` : '';
      text = `${full.slice(0, HEAD_CHARS)}\n\n[Output cut at ${HEAD_CHARS} of ${full.length} characters${where}.]`;
    }

    const isError = Boolean(interrupted) || exit.timedOut || exit.exitCode !== 0;
    return {
      content: [{ type: 'text', text }],
      isError,
      display: {
        ...commandDisplay(input),
        exitCode: exit.exitCode,
        signal: exit.signal,
        stdout: stdout.slice(0, MAX_TOOL_TEXT),
        stderr: stderr.slice(0, MAX_TOOL_TEXT),
        truncated: full.length > MAX_TOOL_TEXT,
        outputPath: logPath,
        timedOut: exit.timedOut,
      },
    };
  }
}

/** Resolves on the first of: exit, the timer (`ms`, null for none), or an abort of `signal`. */
function settleOrTimeout(handle: WorkspaceProcess, ms: number | null, signal: AbortSignal): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: Outcome) => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle({ kind: 'abort' });
    if (signal.aborted) return settle({ kind: 'abort' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (ms !== null) timer = setTimeout(() => settle({ kind: 'timer' }), ms);
    void handle.exited.then((exit) => settle({ kind: 'exit', exit }));
  });
}

function commandDisplay(input: BashInput): { type: 'command'; command: string; description: string } {
  return { type: 'command', command: input.command, description: input.description };
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'command';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
