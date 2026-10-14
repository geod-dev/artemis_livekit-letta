import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const anchor = 'function getCompat(model) {\n  const detected = detectCompat(model);';
const replacement = `function getCompat(model) {
  // Local workaround: Groq's Qwen chat template rejects the developer role.
  // Clone the model so this capability override never enters stored settings.
  if (model.provider === "groq" && model.id.startsWith("qwen/")) {
    model = { ...model, compat: { ...model.compat, supportsDeveloperRole: false } };
  }
  const detected = detectCompat(model);`;

export function patchBundle(source) {
  if (source.split(anchor).length !== 2) {
    throw new Error('Expected exactly one Pi Chat Completions getCompat entry point; revalidate the Letta patch.');
  }
  return source.replace(anchor, replacement);
}

export function patchPackage(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== '@letta-ai/letta-code' || metadata.version !== '0.34.4') {
    throw new Error('Groq Qwen patch is validated only for @letta-ai/letta-code 0.34.4.');
  }
  const bundlePath = join(packageDir, 'letta.js');
  writeFileSync(bundlePath, patchBundle(readFileSync(bundlePath, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node patch-groq-qwen.mjs <Letta package directory>');
  patchPackage(process.argv[2]);
}
