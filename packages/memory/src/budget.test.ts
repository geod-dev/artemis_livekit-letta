import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recallBudget } from './budget.ts';

test('voice always recalls with the low budget', () => {
  assert.equal(recallBudget({ modality: 'voice' }), 'low');
  assert.equal(recallBudget({ modality: 'voice', effort: 'max' }), 'low');
});

test('text maps effort to mid or high', () => {
  assert.equal(recallBudget({ modality: 'text' }), 'mid');
  assert.equal(recallBudget({ modality: 'text', effort: 'low' }), 'mid');
  assert.equal(recallBudget({ modality: 'text', effort: 'medium' }), 'mid');
  assert.equal(recallBudget({ modality: 'text', effort: 'high' }), 'high');
  assert.equal(recallBudget({ modality: 'text', effort: 'xhigh' }), 'high');
  assert.equal(recallBudget({ modality: 'text', effort: 'max' }), 'high');
});
