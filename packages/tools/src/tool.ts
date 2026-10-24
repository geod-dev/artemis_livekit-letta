import { AppError, type JsonSchema, type ToolDefinition } from '@artemis/core';
import Ajv from 'ajv';
import type { ToolContext } from './context.ts';
import type { ToolResult } from './result.ts';

/** Validation failure of a model-supplied input; becomes an `isError` tool result. */
export class ToolInputError extends AppError {
  constructor(message: string) {
    super('invalid_tool_input', message, 400);
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
 * `C` is the context type the tool needs; generic tools use `ToolContext`, and an
 * application's tools may use a `ToolContext` extension it defines for itself.
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
      throw new ToolInputError(
        `${this.name}: ${ajv.errorsText(validate.errors, { dataVar: 'input' })}`
      );
    }
    return input as I;
  }

  abstract execute(input: I, context: C): Promise<ToolResult>;
}

/**
 * Any tool, whatever its input type. `unknown` is the top input type: method parameters are checked
 * bivariantly, so every `Tool<I, C>` is assignable to it without a cast.
 */
export type AnyTool<C extends ToolContext = ToolContext> = Tool<unknown, C>;
