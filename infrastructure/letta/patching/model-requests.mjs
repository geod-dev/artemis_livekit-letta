import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Keep Claude's thinking switch independent from its output effort. */
export function withAssistantClaudeSettings(previous, settings) {
  return async (payload, model) => {
    const params = await previous?.(payload, model) ?? payload;
    params.thinking = { type: settings.thinking?.type === 'disabled' ? 'disabled' : 'adaptive' };
    params.output_config = { ...params.output_config, effort: settings.effort ?? 'medium' };
    delete params.temperature;
    delete params.top_p;
    delete params.top_k;
    return params;
  };
}

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Expected one model request anchor: ${anchor.slice(0, 90)}; revalidate Letta 0.34.4.`);
  }
  return source.replace(anchor, () => replacement);
}

export function patchBundle(source) {
  if (source.includes('function withAssistantClaudeSettings(')) {
    throw new Error('Model request anchor is already patched.');
  }
  source = replaceOnce(source, 'function reasoningForSettings(modelSettings, modelHandle, model) {',
    `${withAssistantClaudeSettings.toString()}\nfunction reasoningForSettings(modelSettings, modelHandle, model) {
  if (modelHandle === "openai-compatible/zai-org/GLM-5.3-Flash") return "high";`);
  source = replaceOnce(source, '    if (resolved2.model.api === "anthropic-messages") {',
    `    if (resolved2.model.api === "anthropic-messages" && resolved2.model.id === "claude-haiku-5-5") {
      options.onPayload = withAssistantClaudeSettings(options.onPayload, input.agent.model_settings);
    }
    if (resolved2.model.api === "anthropic-messages") {`);
  // Cover built-in workers as well as named definitions, including forked workers.
  source = replaceOnce(source, 'const model = isDeployingExisting ? null : await resolveSubagentModel({',
    'const model = await resolveSubagentModel({');
  const argsStart = source.indexOf('function buildSubagentArgs(');
  const argsEnd = source.indexOf('\n}', argsStart) + 2;
  if (argsStart < 0 || argsEnd < argsStart) throw new Error('Missing worker argument anchor');
  const originalArgs = source.slice(argsStart, argsEnd);
  let updatedArgs = replaceOnce(originalArgs, '  const args = [];',
    '  const args = ["--model", process.env.ASSISTANT_TASK_MODEL || "openai-compatible/zai-org/GLM-5.3-Flash"];');
  updatedArgs = replaceOnce(updatedArgs, '    if (model) {\n      args.push("--model", model);\n    }\n', '');
  source = replaceOnce(source, originalArgs, updatedArgs);
  for (const [name, result] of [
    ['resolveSubagentModel', 'process.env.ASSISTANT_TASK_MODEL || "openai-compatible/zai-org/GLM-5.3-Flash"'],
    ['resolveForkModelOverride', '{ modelHandle: process.env.ASSISTANT_TASK_MODEL || "openai-compatible/zai-org/GLM-5.3-Flash", updateArgs: { reasoning_effort: "high" } }'],
  ]) {
    const marker = `async function ${name}(options) {`;
    const start = source.indexOf(marker);
    const end = source.indexOf('\n}', start);
    if (start < 0 || end < start) throw new Error(`Missing model selection anchor: ${name}`);
    source = replaceOnce(source, source.slice(start, end + 2), `async function ${name}(options) {\n  return ${result};\n}`);
  }
  return source;
}

export function patchPackage(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== '@letta-ai/letta-code' || metadata.version !== '0.34.4') {
    throw new Error('Model request patch requires @letta-ai/letta-code 0.34.4.');
  }
  const file = join(packageDir, 'letta.js');
  writeFileSync(file, patchBundle(readFileSync(file, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node model-requests.mjs <Letta package directory>');
  patchPackage(process.argv[2]);
}
