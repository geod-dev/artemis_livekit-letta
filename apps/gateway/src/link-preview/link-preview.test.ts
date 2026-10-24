import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { type PreviewNetwork, linkPreview } from './link-preview';

// The refusals below happen before any connection, and IP literals resolve without DNS.
// The redirect, redirect-limit and size tests run against a loopback page server: the
// injected network resolves every host name to a public address (or a private one, to
// test the refusal) and dials the loopback server instead.

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

/** A page server on loopback; `close` also drops the keep-alive connections. */
async function pageServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every host name resolves to a public address (unless listed), and every connection goes to loopback. */
function network(port: number, resolvesTo: Record<string, string> = {}): PreviewNetwork {
  return {
    ports: [port],
    lookup: async (hostname) => [{ address: resolvesTo[hostname] ?? '93.184.216.34', family: 4 }],
    dial: () => ({ address: '127.0.0.1', family: 4 }),
  };
}

test('a public page yields its title and description', async (t) => {
  const page = await pageServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<html><head><title>Release notes</title><meta name="description" content="What changed"></head></html>'
    );
  });
  t.after(page.close);
  const preview = await linkPreview(`http://example.test:${page.port}/`, network(page.port));
  assert.deepEqual(preview, { title: 'Release notes', description: 'What changed' });
});

test('a redirect to a private host is refused, not followed', async (t) => {
  const page = await pageServer((_request, response) => {
    response.writeHead(302, { Location: 'http://internal.test/admin' });
    response.end();
  });
  t.after(page.close);
  await assert.rejects(
    linkPreview(
      `http://example.test:${page.port}/`,
      network(page.port, { 'internal.test': '10.0.0.5' })
    ),
    /Private destination/
  );
});

test('redirects are followed at most three times', async (t) => {
  let responses = 0;
  const page = await pageServer((_request, response) => {
    responses++;
    response.writeHead(302, { Location: '/next' });
    response.end();
  });
  t.after(page.close);
  await assert.rejects(
    linkPreview(`http://example.test:${page.port}/`, network(page.port)),
    /Too many redirects/
  );
  // The first request and three redirects: four responses, then the refusal.
  assert.equal(responses, 4);
});

test('only the first 256 KB of a page are read', async (t) => {
  const page = await pageServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<title>Early</title>${'x'.repeat(256 * 1024)}<title>Late</title>`);
  });
  t.after(page.close);
  const preview = await linkPreview(`http://example.test:${page.port}/`, network(page.port));
  assert.equal(preview.title, 'Early');
});
