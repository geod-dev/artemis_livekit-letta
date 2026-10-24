import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEMORY_REMEMBER_INPUT_SCHEMA,
  MEMORY_SEARCH_INPUT_SCHEMA,
  runAgentInputSchema,
} from './tool-schemas.ts';

// The schemas are plain JSON Schema objects; these tests pin the constraints a
// valid and an invalid input rely on, without a validator dependency.
interface PropertyShape {
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
}
interface SchemaShape {
  properties: Record<string, PropertyShape>;
  required: string[];
  additionalProperties: boolean;
}
const shapeOf = (schema: unknown): SchemaShape => schema as SchemaShape;

test('run_agent accepts only the subagents the server defines', () => {
  const schema = shapeOf(
    runAgentInputSchema([
      { name: 'researcher', description: 'Finds facts.' },
      { name: 'writer', description: 'Drafts text.' },
    ])
  );
  const allowed = schema.properties.subagent_type?.enum ?? [];

  assert.ok(allowed.includes('writer'), 'a defined subagent is a valid choice');
  assert.equal(allowed.includes('coder'), false, 'an undefined subagent is rejected');
  assert.deepEqual(schema.required, ['subagent_type', 'description', 'prompt']);
  assert.equal(schema.additionalProperties, false);
});

test('memory_search requires a query and limits the budget to low, mid or high', () => {
  const schema = shapeOf(MEMORY_SEARCH_INPUT_SCHEMA);
  const budgets = schema.properties.budget?.enum ?? [];

  assert.deepEqual(schema.required, ['query']);
  assert.equal(schema.properties.query?.minLength, 1, 'an empty query is invalid');
  assert.ok(budgets.includes('mid'));
  assert.equal(budgets.includes('extreme'), false);
  assert.equal(schema.additionalProperties, false);
});

test('memory_remember requires content and bounds its length', () => {
  const schema = shapeOf(MEMORY_REMEMBER_INPUT_SCHEMA);

  assert.deepEqual(schema.required, ['content']);
  assert.equal(schema.properties.content?.minLength, 1, 'empty content is invalid');
  assert.equal(
    schema.properties.content?.maxLength,
    4000,
    'content over 4000 characters is invalid'
  );
  assert.equal(schema.additionalProperties, false);
});
