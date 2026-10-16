import {
  type ToolCall,
  shellCommand,
  webSearchQuery,
} from '../components/assistant-ui/tools/tool-display.ts';
import { type BashOutput, parseBashResult } from './bash-result.ts';
import { type WebSearchOutput, parseWebSearchResult } from './web-search.ts';

export type ToolRenderer =
  | { kind: 'web-search'; query: string; output: WebSearchOutput | null }
  | { kind: 'terminal'; command: string; output: BashOutput | null }
  | { kind: 'generic' };

/** Only file reads opt out of Markdown; web fetches and other tools keep it. */
export function toolResultFormat(call: ToolCall): 'text' | 'markdown' {
  if (call.toolName !== 'Read') return 'markdown';
  const path = call.args.file_path ?? call.args.path;
  if (typeof path !== 'string' || !path.trim()) return 'markdown';
  return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(path) ? 'markdown' : 'text';
}

/** Choose a specialized renderer only when the call and its result are supported. */
export function selectToolRenderer(
  call: ToolCall,
  result: unknown,
  isRunning: boolean,
  isError = false
): ToolRenderer {
  const query = webSearchQuery(call);
  if (query !== undefined) {
    const output = isRunning ? null : parseWebSearchResult(result);
    if (isRunning || output !== null) return { kind: 'web-search', query, output };
  }

  const command = shellCommand(call);
  if (command !== undefined) {
    const output = isRunning ? null : parseBashResult(result, isError);
    if (isRunning || output !== null) return { kind: 'terminal', command, output };
  }

  return { kind: 'generic' };
}
