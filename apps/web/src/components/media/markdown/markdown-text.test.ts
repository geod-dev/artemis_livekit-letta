import assert from 'node:assert/strict';
import { test } from 'node:test';

// markdown-text.tsx reads `window.location.origin` when it loads, and the test
// runs in node. A stub is enough for the module to load; the helper never reads it.
if (!('window' in globalThis)) {
  Object.assign(globalThis, { window: { location: { origin: 'http://localhost' } } });
}
// Loaded by path: the test tsconfig has no JSX setting, so a static import of a .tsx file does not typecheck.
const modulePath = './markdown-text.tsx';
const { linkPreviewHref } = (await import(modulePath)) as {
  linkPreviewHref: (href: string | undefined) => string | undefined;
};

test('malformed https:// link does not request a preview', () => {
  assert.equal(linkPreviewHref('https://'), undefined);
});

test('a web link requests its preview as written', () => {
  assert.equal(linkPreviewHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('links that are not web links request no preview', () => {
  assert.equal(linkPreviewHref('mailto:someone@example.com'), undefined);
  assert.equal(linkPreviewHref('/files/report.pdf'), undefined);
  assert.equal(linkPreviewHref(undefined), undefined);
});
