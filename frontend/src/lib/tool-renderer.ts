import type { ToolDisplay } from '@shared/chat-types';
import { type ToolCall, webSearchQuery } from '../components/assistant-ui/tools/tool-display.ts';
import { TOOL_NAMES } from './tool-names.ts';
import { readToolOutput } from './tool-output.ts';
import { type WebSearchOutput, parseWebSearchResult } from './web-search.ts';

/** A finished shell command as a terminal shows it. */
export interface TerminalOutput {
  /** stdout and stderr, in that order. */
  lines: string[];
  exitCode: number;
  truncated: boolean;
}

export type ToolRenderer =
  | { kind: 'web-search'; query: string; output: WebSearchOutput | null }
  | { kind: 'terminal'; command: string; output: TerminalOutput | null }
  | { kind: 'generic' };

/** Only file reads opt out of Markdown; web fetches and other tools keep it. */
export function toolResultFormat(call: ToolCall): 'text' | 'markdown' {
  if (call.toolName !== TOOL_NAMES.readFile) return 'markdown';
  const path = call.args.path ?? call.args.file_path;
  if (typeof path !== 'string' || !path.trim()) return 'markdown';
  return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(path) ? 'markdown' : 'text';
}

/** Choose a specialized renderer only when the call and its result are supported. */
export function selectToolRenderer(
  call: ToolCall,
  result: unknown,
  isRunning: boolean
): ToolRenderer {
  const query = webSearchQuery(call);
  if (query !== undefined) {
    const output = isRunning ? null : parseWebSearchResult(result);
    if (isRunning || output !== null) return { kind: 'web-search', query, output };
  }

  const display = call.ui.display;
  if (display?.type === 'command' && !display.background) {
    return {
      kind: 'terminal',
      command: display.command,
      output: isRunning ? null : terminalOutput(display, result),
    };
  }

  return { kind: 'generic' };
}

/** A finished command's output and exit status, from its display. */
function terminalOutput(
  display: Extract<ToolDisplay, { type: 'command' }>,
  result: unknown
): TerminalOutput {
  const text =
    display.stdout !== undefined || display.stderr !== undefined
      ? [display.stdout, display.stderr].filter(Boolean).join('\n')
      : readToolOutput(result).text;
  const lines = text.replace(/\s+$/, '').split('\n');
  return {
    // Without an exit code the command was killed: by its timeout, or by a signal.
    exitCode: display.exitCode ?? (display.timedOut ? 124 : 137),
    lines: text.trim() === '' ? [] : lines,
    truncated: display.truncated ?? false,
  };
}
