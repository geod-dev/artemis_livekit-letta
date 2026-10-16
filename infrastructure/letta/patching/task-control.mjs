import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const anchor = 'async function handleExecuteCommand(command, socket, conversationRuntime, opts) {';
const addition = `
  // Gateway task controls bypass the model and operate only on this runtime's work.
  if (command.command_id === "assistant_tasks" || command.command_id === "assistant_task_stop") {
    init_task_stop();
    const owns = (entry) => entry.runtimeScope?.agentId === command.runtime.agent_id &&
      entry.runtimeScope?.conversationId === command.runtime.conversation_id;
    try {
      let value;
      if (command.command_id === "assistant_task_stop") {
        const id = command.args?.trim();
        const entry = backgroundTasks.get(id) ?? backgroundProcesses.get(id);
        if (!entry || !owns(entry)) throw new Error("Task does not belong to this conversation or is no longer available");
        value = entry.status === "running" ? await task_stop({ task_id: id }) : { killed: false };
      } else {
        value = [
          ...Array.from(backgroundTasks.entries()).filter(([, entry]) => owns(entry)).map(([id, entry]) => ({
            id, title: entry.description || "Background task", kind: "agent", status: entry.status,
            report: typeof entry.result === "string" ? entry.result : entry.error || undefined,
          })),
          ...Array.from(backgroundProcesses.entries()).filter(([, entry]) => owns(entry)).map(([id, entry]) => ({
            id, title: entry.description || entry.command || "Background command", kind: "command", status: entry.status,
            report: [...(entry.stdout || []), ...(entry.stderr || [])].join("\\n").slice(-65536) || undefined,
          })),
        ];
      }
      emitExecuteCommandResponse(socket, command, { success: true, output: JSON.stringify(value) });
    } catch (error) {
      emitExecuteCommandResponse(socket, command, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
`;

export function patchBundle(source) {
  if (source.includes('Gateway task controls bypass the model') || source.split(anchor).length !== 2) throw new Error('Expected one unpatched Letta execute-command handler; revalidate task controls.');
  return source.replace(anchor, anchor + addition);
}

export function patchPackage(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== '@letta-ai/letta-code' || metadata.version !== '0.34.4') throw new Error('Task controls require @letta-ai/letta-code 0.34.4.');
  const file = join(packageDir, 'letta.js');
  writeFileSync(file, patchBundle(readFileSync(file, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node task-control.mjs <Letta package directory>');
  patchPackage(process.argv[2]);
}
