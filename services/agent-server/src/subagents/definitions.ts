import { notImplemented } from '@artemis/core';

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

export function loadSubagentDefinitions(_dir: string): Promise<SubagentDefinition[]> {
  return notImplemented('loadSubagentDefinitions');
}

/** True when a report's first non-blank line starts with `NEEDS USER INPUT:`. */
export function needsUserInput(_report: string): boolean {
  return notImplemented('needsUserInput');
}
