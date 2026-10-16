import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextWindowFromEntity, lettaContextTokens } from './context-usage.ts';

const usage = (event: Record<string, unknown>) =>
  ({
    type: 'stream_event',
    uuid: 'usage',
    event: { message_type: 'usage_statistics', ...event },
  }) as SDKMessage;

test('uses Letta context snapshot instead of cumulative billable tokens', () => {
  assert.equal(
    lettaContextTokens(usage({ context_tokens: 74_321, total_tokens: 900_000 })),
    74_321
  );
  assert.equal(
    lettaContextTokens(usage({ total_tokens: 900_000, prompt_tokens: 80_000 })),
    undefined
  );
  assert.equal(lettaContextTokens(usage({ context_tokens: 42_000 })), 42_000);
});

test('unknown or invalid context must not become a zero usage reading', () => {
  for (const context_tokens of [null, undefined, -1, NaN, Infinity, '100'])
    assert.equal(lettaContextTokens(usage({ context_tokens })), undefined);
  assert.equal(lettaContextTokens(usage({ context_tokens: 0 })), 0);
  assert.equal(
    lettaContextTokens(usage({ message_type: 'assistant_message', context_tokens: 100 })),
    undefined
  );
});

test('context limit follows Letta overrides and has no default magic number', () => {
  assert.equal(contextWindowFromEntity({ context_window_limit: 1_000_000 }), 1_000_000);
  assert.equal(
    contextWindowFromEntity({
      context_window_limit: 64_000,
      llm_config: { context_window: 1_000_000 },
    }),
    64_000
  );
  assert.equal(contextWindowFromEntity({ llm_config: { context_window: 1_000_000 } }), 1_000_000);
  for (const value of [{}, null, { context_window_limit: 0 }, { context_window_limit: NaN }])
    assert.equal(contextWindowFromEntity(value), undefined);
});
