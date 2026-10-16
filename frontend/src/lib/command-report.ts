import type { ConversationTask } from '@shared/chat-types';

/** Decode Letta's command notification envelope without guessing an exit status. */
export function commandReport(
  task: Pick<ConversationTask, 'report' | 'command' | 'stdout' | 'stderr' | 'exitCode' | 'prompt'>
) {
  let text = (task.report ?? '').replaceAll('\r\n', '\n');
  let command = task.prompt ?? task.command;
  let enveloped = false;
  if (command && text.startsWith(`$ ${command}\n\n`)) {
    text = text.slice(command.length + 4);
    enveloped = true;
  } else {
    const header = text.match(
      /^\$ ([\s\S]*?)\n\n(?=(?:Session ID:|Exit code:|Terminated by signal|Error:|Command timed out))/
    );
    if (header) {
      command ??= header[1];
      text = text.slice(header[0].length);
      enveloped = true;
    }
  }
  let exitCode = typeof task.exitCode === 'number' ? task.exitCode : undefined;
  if (enveloped) {
    text = text.replace(/^Session ID: [^\n]+\n\n/, '');
    const code = text.match(/^Exit code: (-?\d+)(?:\n\n|$)/);
    if (code) {
      exitCode ??= Number(code[1]);
      text = text.slice(code[0].length);
    } else {
      text = text.replace(
        /^(?:Terminated by signal before exiting|Error: [^\n]*|Command timed out[^\n]*)(?:\n\n|$)/,
        ''
      );
    }
    text = text.replace(/(^|\n\n)\[(?:stdout|stderr)(?: - last \d+ of \d+ lines)?\]\n/g, '$1');
    if (text === '(no output)') text = '';
  }
  const output =
    task.stdout !== undefined || task.stderr !== undefined
      ? [task.stdout, task.stderr].filter(Boolean).join('\n')
      : text;
  return { command, output, exitCode };
}
