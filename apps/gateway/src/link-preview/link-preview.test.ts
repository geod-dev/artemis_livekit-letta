import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkPreview } from './link-preview';

// These run offline: the refusals happen before any connection, and IP literals resolve
// without DNS. Redirects to private hosts and oversized bodies need a public host, so
// they are not covered here.

test('loopback, private, link-local, carrier-NAT and unique-local destinations are refused', async () => {
  for (const href of [
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[2002::1]/',
  ]) {
    await assert.rejects(linkPreview(href), /Private destination/, href);
  }
});

test('only plain web URLs without credentials or unusual ports are read', async () => {
  for (const href of [
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://user:secret@127.0.0.1/',
    'http://127.0.0.1:8080/',
  ]) {
    await assert.rejects(linkPreview(href), /Unsupported URL/, href);
  }
});
