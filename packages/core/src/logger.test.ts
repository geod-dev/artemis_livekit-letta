import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleLogger } from './logger.ts';

test('console logger prefixes the scope and passes fields through', (t) => {
  const info = t.mock.method(console, 'info', () => {});
  const logger = consoleLogger('gateway');
  logger.info('ready', { port: 3000 });
  logger.info('bare');
  assert.deepEqual(info.mock.calls[0]?.arguments, ['[gateway] ready', { port: 3000 }]);
  assert.deepEqual(info.mock.calls[1]?.arguments, ['[gateway] bare']);
});

test('child loggers extend the scope', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  consoleLogger('agent').child('mcp').warn('slow');
  assert.deepEqual(warn.mock.calls[0]?.arguments, ['[agent:mcp] slow']);
});

test('debug output is only emitted when LOG_LEVEL is debug', (t) => {
  const debug = t.mock.method(console, 'debug', () => {});
  const previous = process.env.LOG_LEVEL;
  try {
    delete process.env.LOG_LEVEL;
    consoleLogger('x').debug('hidden');
    assert.equal(debug.mock.callCount(), 0);
    process.env.LOG_LEVEL = 'debug';
    consoleLogger('x').debug('shown');
    assert.deepEqual(debug.mock.calls[0]?.arguments, ['[x] shown']);
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});
