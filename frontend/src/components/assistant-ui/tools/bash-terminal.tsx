import { TerminalBlock } from '@/components/assistant-ui/tools/terminal-block';
import type { BashOutput } from '@/lib/bash-result';

/**
 * A shell command's details as a terminal: the command, its output and its
 * exit status. `output` is null while the command runs.
 */
export function BashTerminal({ command, output }: { command: string; output: BashOutput | null }) {
  const lines = output?.lines ?? [];
  return (
    <TerminalBlock
      command={command}
      lines={lines}
      visibleCount={lines.length}
      done={output !== null}
      exitCode={output?.exitCode}
      truncated={output?.truncated}
      maxCollapsedLines={12}
      className="max-w-none"
    />
  );
}
