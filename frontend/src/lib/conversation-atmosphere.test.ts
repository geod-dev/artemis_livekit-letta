import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnAtmosphere } from './conversation-atmosphere.ts';

test('idle history never illuminates old unfinished tools', () => {
  assert.equal(turnAtmosphere(false, [{ type: 'tool-call' }]), 'idle');
});
test('waiting and streamed reasoning illuminate thinking', () => {
  assert.equal(turnAtmosphere(true, []), 'thinking');
  assert.equal(
    turnAtmosphere(true, [
      { type: 'text', text: 'Earlier thought' },
      { type: 'reasoning', text: 'Considering' },
    ]),
    'thinking'
  );
});
test('tool lighting lasts only while a tool is pending or preliminary', () => {
  assert.equal(turnAtmosphere(true, [{ type: 'tool-call' }]), 'tools');
  assert.equal(
    turnAtmosphere(true, [{ type: 'tool-call', result: 'Partial', isPreliminary: true }]),
    'tools'
  );
  assert.equal(
    turnAtmosphere(true, [
      { type: 'tool-call', result: '' },
      { type: 'text', text: 'Done' },
    ]),
    'idle'
  );
  assert.equal(
    turnAtmosphere(true, [
      { type: 'tool-call', isError: true },
      { type: 'text', text: 'Explaining the error' },
    ]),
    'idle'
  );
});
test('streaming readable prose settles the background', () => {
  assert.equal(
    turnAtmosphere(true, [{ type: 'text', text: 'A long answer is arriving.' }]),
    'idle'
  );
  assert.equal(turnAtmosphere(true, [{ type: 'text', text: '   ' }]), 'thinking');
});
