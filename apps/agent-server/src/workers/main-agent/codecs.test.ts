import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineImageType } from './codecs.ts';

test('an image type the model accepts inline is returned as is', () => {
  assert.equal(inlineImageType('image/png'), 'image/png');
});

test('anything else is not sent inline', () => {
  assert.equal(inlineImageType('application/pdf'), null);
  assert.equal(inlineImageType('image/x-unknown'), null);
  assert.equal(inlineImageType(undefined), null);
});
