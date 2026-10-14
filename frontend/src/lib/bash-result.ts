import { toolOutputText } from './tool-output.ts';

/** A finished Bash call as a terminal shows it. */
export interface BashOutput {
  /** stdout and stderr, which Letta returns merged. */
  lines: string[];
  exitCode: number;
  truncated: boolean;
}

const NO_OUTPUT = '(Command completed with no output)';
const INTERRUPTED = 'Interrupted by user';
const BACKGROUND =
  /^(Command running in background with ID:|Command is still running with task ID:)/m;
const EXIT_CODE = /^Exit code: (-?\d+)\n?/;
const SIGNALLED = /^Terminated by signal before exiting\n?/;
const TRUNCATION = /\n*\[Output truncated: [^\]]*\](?:\n\[Full output written to: [^\]]*\])?\s*$/;

/**
 * Read a Letta Code `Bash` result. Successful commands return their output; a
 * failed one starts with `Exit code: N`; output over the limit ends with a
 * truncation notice. Returns null for results that are not a command's
 * output (background commands), which keep the generic tool display.
 */
export function parseBashResult(result: unknown, isError = false): BashOutput | null {
  const outputText = toolOutputText(result);
  if (outputText === null) return null;
  if (BACKGROUND.test(outputText)) return null;
  if (isError && outputText.trim() === INTERRUPTED) {
    return { lines: [INTERRUPTED], exitCode: 130, truncated: false };
  }

  let text = outputText;
  let exitCode = 0;
  if (isError) {
    const code = EXIT_CODE.exec(text);
    const signalled = SIGNALLED.exec(text);
    exitCode = code ? Number(code[1]) : signalled ? 137 : 1;
    text = text.slice((code ?? signalled)?.[0].length ?? 0);
  }
  const truncated = TRUNCATION.test(text);
  if (truncated) text = text.replace(TRUNCATION, '');
  text = text.replace(/\s+$/, '');
  const lines = text === '' || text === NO_OUTPUT ? [] : text.split('\n');
  return { lines, exitCode, truncated };
}
