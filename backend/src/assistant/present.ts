import Ajv2020 from 'ajv/dist/2020.js';
import componentSchemas from '../../../shared/generated/present-components.json' with { type: 'json' };
import presentTool from '../../../shared/generated/present-tool.json' with { type: 'json' };
import { validatePresentTree } from '../../../shared/present-validation.ts';

/**
 * Generative UI. The tool schema guides the model; this runtime validator uses
 * the generated per-component schemas before reporting that anything was shown.
 */
export const PRESENT_TOOL = presentTool.name;
export const presentDescription = presentTool.description;
export const presentParameters = presentTool.parameters;

const ajv = new Ajv2020({ allowUnionTypes: true });
const componentValidators = Object.fromEntries(
  Object.entries(componentSchemas).map(([name, schema]) => [name, ajv.compile(schema)])
);
const COMPONENTS = Object.keys(componentValidators);

/** The invalid component or bounded protocol error, if this is not a valid tree. */
export function unknownComponents(node: unknown): string[] {
  const result = validatePresentTree(node, (type, props) => {
    const validate = componentValidators[type as keyof typeof componentValidators];
    return validate !== undefined && validate(props);
  });
  return result.ok ? [] : [result.error];
}

/** The tool's answer to the model. */
export function presentOutcome(input: unknown): { text: string; isError: boolean } {
  const invalid = unknownComponents(input);
  if (invalid.length > 0) {
    return {
      text: `Not shown: ${invalid[0]} Use only these components: ${COMPONENTS.join(', ')}.`,
      isError: true,
    };
  }
  return { text: 'Shown to the user in the chat.', isError: false };
}
