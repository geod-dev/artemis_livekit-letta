import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkMetadata } from '../link-preview/link-description';
import { createLinkPreviewRoutes } from './link-previews';

function appWith(linkPreview: (href: string) => Promise<LinkMetadata>): Hono {
  return new Hono().route('/api', createLinkPreviewRoutes({ linkPreview }));
}

test('a link preview without a url is refused in the API error envelope', async () => {
  const app = appWith(async () => {
    throw new Error('not used');
  });
  const response = await app.request('http://localhost/api/link-preview');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'url is required' });
});

test('a link preview returns the metadata of the page', async () => {
  const app = appWith(async (href) => ({ title: `title of ${href}`, description: 'd' }));
  const response = await app.request(
    'http://localhost/api/link-preview?url=https%3A%2F%2Fexample.com%2Fa'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: 'title of https://example.com/a',
    description: 'd',
  });
  // Caching is the gateway's default for /api responses; the route sets no public cache policy.
  assert.doesNotMatch(response.headers.get('cache-control') ?? '', /public/);
});

test('a failing link preview is an empty result, not an error', async () => {
  const app = appWith(async () => {
    throw new Error('redirect to a private host');
  });
  const response = await app.request(
    'http://localhost/api/link-preview?url=https%3A%2F%2Fexample.com'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.doesNotMatch(response.headers.get('cache-control') ?? '', /public/);
});
