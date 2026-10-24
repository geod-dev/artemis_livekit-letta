/**
 * Input schemas of the agent-server tools that are not generated from a file (the present tool keeps its
 * generated schema in generated/present-tool.json). One place for the wire contract of these tools.
 * Plain JSON Schema objects, so this package keeps no runtime dependency.
 */
type ToolInputSchema = Record<string, unknown>;

/** A subagent the server can start through `run_agent`. */
export interface SubagentChoice {
  name: string;
  description: string;
}

/** Input of `run_agent`: `subagent_type` is limited to the subagents the server defines. */
export function runAgentInputSchema(subagents: readonly SubagentChoice[]): ToolInputSchema {
  return {
    type: 'object',
    properties: {
      subagent_type: {
        type: 'string',
        enum: subagents.map((subagent) => subagent.name),
        description: subagents.map((subagent) => `${subagent.name}: ${subagent.description}`).join(' | '),
      },
      description: { type: 'string', minLength: 1, description: 'Short title shown in the UI.' },
      prompt: { type: 'string', minLength: 1, description: 'Complete assignment: the subagent sees nothing else.' },
      resume_task_id: { type: 'string', minLength: 1, description: 'Continue this earlier subagent task.' },
    },
    required: ['subagent_type', 'description', 'prompt'],
    additionalProperties: false,
  };
}

/** Input of `memory_search`. */
export const MEMORY_SEARCH_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 2000, description: 'What to look for, in natural language.' },
    budget: {
      type: 'string',
      enum: ['low', 'mid', 'high'],
      description: 'How much to retrieve. Defaults to the budget of the current turn.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

/** Input of `memory_remember`. */
export const MEMORY_REMEMBER_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    content: { type: 'string', minLength: 1, maxLength: 4000, description: 'The note, self-contained.' },
    context: { type: 'string', maxLength: 500, description: 'Why it matters or where it comes from.' },
  },
  required: ['content'],
  additionalProperties: false,
};
