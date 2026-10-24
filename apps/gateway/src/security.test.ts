import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalOrPrivateAddress, sameSecret } from './security.ts';

test('sameSecret accepts only the exact expected secret', () => {
  assert.equal(sameSecret('s3cret', 's3cret'), true);
  assert.equal(sameSecret('s3cre', 's3cret'), false);
  assert.equal(sameSecret('s3cret!', 's3cret'), false);
  assert.equal(sameSecret(undefined, 's3cret'), false);
});

test('sameSecret never accepts when there is no expected secret configured', () => {
  assert.equal(sameSecret('', ''), false);
  assert.equal(sameSecret('anything', ''), false);
});

test('isLocalOrPrivateAddress accepts loopback, private, link-local and IPv4-mapped peers', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.5',
  ]) {
    assert.equal(isLocalOrPrivateAddress(address), true, address);
  }
});

test('isLocalOrPrivateAddress refuses public, documentation and non-address values', () => {
  for (const address of [
    '8.8.8.8',
    '172.32.0.1',
    '203.0.113.9',
    '2001:db8::1',
    '::ffff:203.0.113.9',
    'example.com',
    '',
  ]) {
    assert.equal(isLocalOrPrivateAddress(address), false, address);
  }
});
