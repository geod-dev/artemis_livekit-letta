import Ajv from 'ajv';
import type { JsonSchema, ToolDefinition } from '@artemis/llm';
import type { ToolContext } from './context.ts';
import type { ToolResult } from './result.ts';

/** Validation failure of a model-supplied input; becomes an `isError` tool result. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// Ajv caches compiled validators per schema object, so each tool compiles once.
const ajv = new Ajv({ strict: false, allErrors: false });

/**
 * One tool the model can call. Subclasses declare name/description/schema and
 * implement `execute`. Tools never throw for expected failures: they return
 * `{isError: true}` results the model can read. Unexpected throws are turned
 * into error results by the executor.
 *
 * `C` is the context type the tool needs; generic tools use `ToolContext`,
 * agent-server tools use its `AgentToolContext` extension.
 */
export abstract class Tool<I = Record<string, unknown>, C extends ToolContext = ToolContext> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: JsonSchema;
  /** Read-only tools may run in parallel with others without ordering concerns. */
  readonly readOnly: boolean = false;

  definition(): ToolDefinition {
    return { name: this.name, description: this.description, inputSchema: this.inputSchema };
  }

  /** Validate `input` against `inputSchema` (ajv, cached per tool); throws `ToolInputError`. */
  parse(input: unknown): I {
    const validate = ajv.compile(this.inputSchema);
    if (!validate(input)) {
      throw new ToolInputError(`${this.name}: ${ajv.errorsText(validate.errors, { dataVar: 'input' })}`);
    }
    return input as I;
  }

  abstract execute(input: I, context: C): Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<C extends ToolContext = ToolContext> = Tool<any, C>;
