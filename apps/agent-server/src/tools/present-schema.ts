import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import presentComponents from '@artemis/contracts/present-components.json' with { type: 'json' };

/** Checks the props of one `present` component against its generated JSON schema. */
export interface PresentValidator {
  /** Component names the present protocol accepts. */
  readonly components: readonly string[];
  /** True when `props` satisfy the schema of component `type`. */
  validateProps(type: string, props: unknown): boolean;
}

/** Compiles the per-component JSON schemas once; the tree check stays in `validatePresentTree`. */
export function createPresentValidator(): PresentValidator {
  const ajv = new Ajv2020({ allowUnionTypes: true });
  const validators = new Map<string, ValidateFunction>(
    Object.entries(presentComponents).map(([name, schema]) => [name, ajv.compile(schema as object)])
  );
  return {
    components: [...validators.keys()],
    validateProps: (type, props) => validators.get(type)?.(props) === true,
  };
}
