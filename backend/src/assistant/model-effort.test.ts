import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelEffort } from './model-effort.ts';

test('GLM 5.3 smart slider selects three distinct supported SDK tiers', () => {
  for (const handle of ['openai-compatible/zai-org/GLM-5.3-Flash', 'zai/glm-5.3']) {
    assert.deepEqual(
      ['low', 'medium', 'high'].map((e) => modelEffort(handle, e)),
      ['low', 'high', 'xhigh']
    );
  }
});

test('other models and configured defaults retain their own effort values', () => {
  assert.equal(modelEffort('groq/openai/gpt-oss-120b', 'medium'), 'medium');
  assert.equal(modelEffort('zai/glm-5.3', ''), '');
  assert.equal(modelEffort('zai/glm-5.3', 'xhigh'), 'xhigh');
});
