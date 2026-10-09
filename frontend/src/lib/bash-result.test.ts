import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBashResult } from './bash-result.ts';

test('reads the output of a successful command', () => {
  assert.deepEqual(parseBashResult('a\nb\n'), { lines: ['a', 'b'], exitCode: 0, truncated: false });
});

test('shows no lines for a command without output', () => {
  assert.deepEqual(parseBashResult('(Command completed with no output)'), {
    lines: [],
    exitCode: 0,
    truncated: false,
  });
});

test('takes the exit code from a failed command', () => {
  assert.deepEqual(parseBashResult('Exit code: 2\nls: cannot access', true), {
    lines: ['ls: cannot access'],
    exitCode: 2,
    truncated: false,
  });
});

test('strips the truncation notice', () => {
  const result =
    'line 1\nline 2\n\n[Output truncated: showing 2 of 9,000 characters.]\n[Full output written to: /tmp/x]';
  assert.deepEqual(parseBashResult(result), {
    lines: ['line 1', 'line 2'],
    exitCode: 0,
    truncated: true,
  });
});

test('leaves background commands to the generic display', () => {
  assert.equal(parseBashResult('Command running in background with ID: b1\nOutput file: /x'), null);
  assert.equal(parseBashResult(undefined), null);
});
