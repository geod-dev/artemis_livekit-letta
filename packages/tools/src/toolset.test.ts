import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@artemis/core';
import { Tool } from './tool.ts';
import type { ToolContext } from './context.ts';
import { errorResult, textResult, type ToolResult } from './result.ts';
import { Toolset } from './toolset.ts';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const context = {
  logger: silent,
  signal: new AbortController().signal,
} as unknown as ToolContext;

class EchoTool extends Tool<{ text: string; count?: number }> {
  readonly name = 'echo';
  readonly description = 'Echo the text back.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
    },
    required: ['text'],
    additionalProperties: false,
  };

  async execute(input: { text: string; count?: number }): Promise<ToolResult> {
    return textResult(input.text.repeat(input.count ?? 1));
  }
}

class ThrowingTool extends Tool {
  readonly name = 'boom';
  readonly description = 'Always throws.';
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };

  async execute(): Promise<ToolResult> {
    throw new Error('kaboom');
  }
}

class OtherTool extends Tool {
  readonly name = 'other';
  readonly description = 'Another tool.';
  readonly inputSchema = { type: 'object', properties: {} };
  override readonly readOnly = true;

  async execute(): Promise<ToolResult> {
    return errorResult('nope');
  }
}

function resultText(result: ToolResult): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

test('definitions keep insertion order and are stable', () => {
  const set = new Toolset([new ThrowingTool(), new EchoTool()]);
  assert.deepEqual(
    set.definitions().map((definition) => definition.name),
    ['boom', 'echo']
  );
  assert.equal(set.definitions()[1]?.description, 'Echo the text back.');
});

test('duplicate names are rejected and with() appends new tools', () => {
  assert.throws(() => new Toolset([new EchoTool(), new EchoTool()]), /Duplicate tool name: echo/);
  const extended = new Toolset([new EchoTool()]).with([new OtherTool()]);
  assert.deepEqual(
    extended.definitions().map((definition) => definition.name),
    ['echo', 'other']
  );
  assert.ok(extended.get('other'));
  assert.equal(extended.get('missing'), undefined);
});

test('execute validates input with the schema before running the tool', async () => {
  const set = new Toolset([new EchoTool()]);
  const ok = await set.execute('echo', { text: 'ab', count: 2 }, context);
  assert.equal(ok.isError, false);
  assert.equal(resultText(ok), 'abab');

  const missing = await set.execute('echo', { count: 2 }, context);
  assert.equal(missing.isError, true);
  assert.match(resultText(missing), /echo: .*required|must have required property 'text'/);

  const extra = await set.execute('echo', { text: 'x', nope: true }, context);
  assert.equal(extra.isError, true);

  const badType = await set.execute('echo', { text: 'x', count: 0 }, context);
  assert.equal(badType.isError, true);
});

test('unknown tools and unexpected throws become error results', async () => {
  const set = new Toolset([new ThrowingTool()]);
  const unknown = await set.execute('nope', {}, context);
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /Unknown tool "nope"/);

  const thrown = await set.execute('boom', {}, context);
  assert.equal(thrown.isError, true);
  assert.match(resultText(thrown), /boom failed: kaboom/);
});

test('parse returns the input unchanged when valid and throws ToolInputError otherwise', () => {
  const tool = new EchoTool();
  assert.deepEqual(tool.parse({ text: 'hi' }), { text: 'hi' });
  assert.throws(() => tool.parse({}), /required/);
  assert.deepEqual(tool.definition(), {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: tool.inputSchema,
  });
});
