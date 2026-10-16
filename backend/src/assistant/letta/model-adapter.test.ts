import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantModelSettings } from './model-adapter.ts';

test('text keeps each selected effort with adaptive thinking', () => {
  for (const effort of ['low', 'medium', 'high'] as const) {
    const settings = assistantModelSettings('text', effort);
    assert.equal(settings.effort, effort);
    assert.equal(settings.thinking.type, 'enabled');
  }
});

test('voice overrides text effort and disables thinking independently', () => {
  for (const effort of ['low', 'medium', 'high'] as const) {
    const settings = assistantModelSettings('voice', effort);
    assert.equal(settings.effort, 'medium');
    assert.equal(settings.thinking.type, 'disabled');
  }
  assert.equal(assistantModelSettings('text').effort, 'medium');
});
