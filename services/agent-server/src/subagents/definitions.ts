import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Subagent definitions from `prompts/agents/*.md` (ported from
 * infrastructure/letta/agents/): frontmatter `name`, `description`; body =
 * instructions. Every subagent gets the full main-agent toolset under the
 * `synchronous` policy and runs on the `worker` model route.
 */
export interface SubagentDefinition {
  name: string;
  description: string;
  instructions: string;
}

export const NEEDS_USER_INPUT_PREFIX = 'NEEDS USER INPUT:';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Parses one definition file; throws when the name or description is missing. */
export function parseSubagentDefinition(source: string, origin = 'definition'): SubagentDefinition {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error(`Subagent ${origin} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!NAME_PATTERN.test(name)) throw new Error(`Subagent ${origin} needs a lowercase "name"`);
  if (!description) throw new Error(`Subagent ${name} needs a "description"`);
  return { name, description, instructions: source.slice(match[0].length).trim() };
}

/** Every `*.md` file of the directory, sorted by name. Throws on an invalid or duplicate definition. */
export async function loadSubagentDefinitions(dir: string): Promise<SubagentDefinition[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();
  const definitions: SubagentDefinition[] = [];
  for (const file of files) {
    const definition = parseSubagentDefinition(await readFile(join(dir, file), 'utf8'), file);
    if (definitions.some((existing) => existing.name === definition.name)) {
      throw new Error(`Duplicate subagent name: ${definition.name}`);
    }
    definitions.push(definition);
  }
  return definitions;
}

/** True when a report's first non-blank line starts with `NEEDS USER INPUT:`. */
export function needsUserInput(report: string): boolean {
  const firstLine = report.split(/\r?\n/).find((line) => line.trim() !== '');
  return firstLine?.trimStart().startsWith(NEEDS_USER_INPUT_PREFIX) ?? false;
}
