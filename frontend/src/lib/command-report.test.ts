import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandReport } from './command-report.ts';

test('command reports separate the command, keep both streams and preserve the actual exit code', () => {
  assert.deepEqual(
    commandReport({
      report: '$ echo test\n\nExit code: 7\n\n[stdout]\nhello\n\n[stderr]\nwarning',
    }),
    {
      command: 'echo test',
      output: 'hello\n\nwarning',
      exitCode: 7,
    }
  );
  assert.deepEqual(commandReport({ report: '$ exit 42\n\nExit code: 42\n\n[stderr]\nfailed' }), {
    command: 'exit 42',
    output: 'failed',
    exitCode: 42,
  });
});

test('native task fields preserve stderr, empty stdout and zero exit status', () => {
  assert.deepEqual(commandReport({ command: 'test', stdout: '', stderr: 'warning', exitCode: 0 }), {
    command: 'test',
    output: 'warning',
    exitCode: 0,
  });
  assert.deepEqual(
    commandReport({ report: '$ sleep 5\n\nTerminated by signal before exiting\n\n(no output)' }),
    {
      command: 'sleep 5',
      output: '',
      exitCode: undefined,
    }
  );
  assert.equal(
    commandReport({ report: 'Exit code: 99\n[stdout]\nUser output' }).output,
    'Exit code: 99\n[stdout]\nUser output'
  );
});

test('multiline commands and exec session metadata are absent from the output', () => {
  const prompt = 'printf first\nprintf second';
  assert.deepEqual(
    commandReport({ prompt, report: `$ ${prompt}\n\nSession ID: 123\n\nExit code: 2\n\nresult` }),
    {
      command: prompt,
      output: 'result',
      exitCode: 2,
    }
  );
});
