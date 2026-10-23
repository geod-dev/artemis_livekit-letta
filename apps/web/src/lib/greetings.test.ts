import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greetingsFor, pickGreeting } from './greetings.ts';

test('time-capped greetings only appear in their hours', () => {
  assert.ok(greetingsFor(9, 'Artemis').includes('Good morning!'));
  assert.ok(!greetingsFor(15, 'Artemis').includes('Good morning!'));
  assert.ok(greetingsFor(15, 'Artemis').includes('Good afternoon!'));
  assert.ok(greetingsFor(23, 'Artemis').includes('Working that late?'));
  assert.ok(greetingsFor(2, 'Artemis').includes('Working that late?'));
  assert.ok(!greetingsFor(9, 'Artemis').includes('Working that late?'));
});

test('offers around thirty lines and fills in the name', () => {
  const pool = greetingsFor(10, 'Artemis');
  assert.ok(pool.length >= 20 && pool.length <= 35);
  assert.ok(pool.includes('Artemis, right here.'));
});

test('picks deterministically from the pool', () => {
  const at = new Date(2026, 9, 6, 9);
  assert.equal(
    pickGreeting('Artemis', at, () => 0),
    'What are we working on?'
  );
  assert.equal(
    pickGreeting('Artemis', at, () => 0.9999),
    'Early start, nice.'
  );
});
