import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePresentTree } from './present-validation.ts';

// The limits of present-validation.ts (not exported; the test pins them).
const PRESENT_LIMITS = { maxDepth: 32, maxNodes: 256, maxStringBytes: 32 * 1024 } as const;

const acceptAll = () => true;
const knownTypes = (type: string) => type === 'Card' || type === 'Text' || type === 'Stack';

function nested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { componentType: 'Text', text: 'leaf' };
  for (let i = 0; i < depth; i += 1) node = { componentType: 'Card', children: node };
  return node;
}

test('accepts a small valid tree and keeps its props', () => {
  const result = validatePresentTree(
    { componentType: 'Card', title: 'Hello', children: [{ componentType: 'Text', text: 'x' }] },
    knownTypes,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.tree.$type, 'Card');
  assert.equal(result.tree.title, 'Hello');
});

test('rejects a component the library does not know', () => {
  const result = validatePresentTree({ componentType: 'Bogus' }, knownTypes);
  assert.deepEqual(result, {
    ok: false,
    error: 'A component name or its properties are not supported.',
  });
});

test('rejects a root that is not a component object', () => {
  const result = validatePresentTree(['not', 'a', 'component'], acceptAll);
  assert.equal(result.ok, false);
});

test('rejects a tree deeper than the depth limit', () => {
  const result = validatePresentTree(nested(PRESENT_LIMITS.maxDepth + 5), acceptAll);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /too deep/);
});

test('rejects a tree with more nodes than the node limit', () => {
  const children = Array.from({ length: PRESENT_LIMITS.maxNodes + 10 }, () => 'x');
  const result = validatePresentTree({ componentType: 'Stack', children }, acceptAll);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /too many nodes/);
});

test('rejects a string larger than the per-string byte limit', () => {
  const result = validatePresentTree(
    { componentType: 'Text', text: 'a'.repeat(PRESENT_LIMITS.maxStringBytes + 1) },
    acceptAll,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /string in the component tree is too large/);
});

test('rejects a cycle in the input', () => {
  const node: Record<string, unknown> = { componentType: 'Text', text: 'x' };
  node.self = node;
  const result = validatePresentTree(node, acceptAll);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /cycle or shared object/);
});
