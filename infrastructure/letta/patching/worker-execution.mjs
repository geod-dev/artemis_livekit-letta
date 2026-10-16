import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Workers have one final report, so tools must not return a background receipt
// whose completion would require another turn. Scope this to the active runtime:
// the listener can host both parent and worker sessions in the same process.
const helper = `function assistantWorkerExecution() {
  const env = getRuntimeExecutionEnv(process.env, getRuntimeContext()?.executionSettings);
  return env.LETTA_CODE_AGENT_ROLE === "subagent" || getCurrentSubagentDepth() > 0;
}
`;

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Expected one unpatched worker execution anchor: ${anchor.slice(0, 90)}; revalidate Letta 0.34.4.`);
  }
  return source.replace(anchor, () => replacement);
}

export function patchBundle(source) {
  if (source.includes('function assistantWorkerExecution()')) throw new Error('Worker execution is already patched.');
  source = replaceOnce(source, 'async function bash(args) {', helper + `async function bash(args) {
  const worker = assistantWorkerExecution();
  if (worker) args = { ...args, run_in_background: false };`);
  source = replaceOnce(source,
    'if (!run_in_background && commandRunsForegroundSleep(command)) {',
    'if (!worker && !run_in_background && commandRunsForegroundSleep(command)) {');
  source = replaceOnce(source,
    'const outcome = isQueueBridgeConnected() ? await Promise.race([',
    'const outcome = !worker && isQueueBridgeConnected() ? await Promise.race([');
  source = replaceOnce(source,
    'async function autoBackgroundExternalTool(toolName2, tool, operation, options) {',
    `async function autoBackgroundExternalTool(toolName2, tool, operation, options) {
  if (assistantWorkerExecution()) return operation;`);

  // Models using the Codex toolset receive exec_command instead of Bash.
  source = replaceOnce(source,
    'timeoutMs: 0,\n      sourceCommand: args.cmd,',
    'timeoutMs: assistantWorkerExecution() ? 120000 : 0,\n      sourceCommand: args.cmd,');
  source = replaceOnce(source,
    'const yieldTimeMs = clampYieldTime(args.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS);',
    'const yieldTimeMs = assistantWorkerExecution() ? Infinity : clampYieldTime(args.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS);');

  source = replaceOnce(source, 'async function monitor(args) {', `async function monitor(args) {
  if (assistantWorkerExecution()) throw new Error("Workers cannot start persistent monitors. Complete a bounded command synchronously or report the monitoring requirement to the parent.");`);

  // Change both model-facing representations without mutating the parent's tools.
  source = replaceOnce(source, '  const scoped = new Map(registry3);\n  if (!canLaunchSubagentsAtDepth(depth))', `  const scoped = new Map(registry3);
  scoped.delete("Monitor");
  for (const name of ["Bash", "exec_command"]) {
    const tool = scoped.get(name);
    if (!tool) continue;
    const workerDescription = name === "Bash"
      ? "Execute a shell command and return its completed output. Worker commands always run synchronously, even if run_in_background is true. Foreground sleep is allowed. The timeout defaults to 120000 ms and is capped at 600000 ms. Do not detach processes with &, nohup, or similar shell mechanisms. Collect the result before returning your final report."
      : "Execute a command and wait for its completed output. Worker commands do not yield sessions or completion notifications; yield_time_ms is ignored. Commands time out after 120000 ms. Do not detach processes or start interactive sessions that need later input.";
    const originalDescription = tool.schema.description;
    const retainedDescription = name === "Bash"
      ? originalDescription.split("\\n").filter((line) => !/^  - (Ordinary commands|Set |Pick between Bash)/.test(line)).join("\\n")
      : originalDescription.slice(originalDescription.indexOf("Provide the required"));
    const description = workerDescription + "\\n\\n" + retainedDescription;
    const inputSchema = { ...tool.schema.input_schema, properties: { ...tool.schema.input_schema.properties } };
    if (name === "Bash") inputSchema.properties.run_in_background = { type: "boolean", description: "Ignored in workers: commands always run synchronously." };
    if (name === "exec_command") inputSchema.properties.yield_time_ms = { type: "number", description: "Ignored in workers: commands wait for completion." };
    scoped.set(name, { ...tool, schema: { ...tool.schema, description, input_schema: inputSchema }, modelForm: resolvedModelForm(tool.modelForm, description, inputSchema) });
  }
  if (!canLaunchSubagentsAtDepth(depth))`);
  return source;
}

export function patchPackage(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== '@letta-ai/letta-code' || metadata.version !== '0.34.4') {
    throw new Error('Worker execution requires @letta-ai/letta-code 0.34.4.');
  }
  const file = join(packageDir, 'letta.js');
  writeFileSync(file, patchBundle(readFileSync(file, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node worker-execution.mjs <Letta package directory>');
  patchPackage(process.argv[2]);
}
