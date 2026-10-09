import assert from 'node:assert/strict';
import test from 'node:test';
import { linkDescription, linkMetadata } from './link-description.ts';

test('prefers social preview titles and decodes their text', () => {
  assert.equal(
    linkMetadata(
      `<head><title>Document title</title><meta name="twitter:title" content="Twitter title"><meta property="og:title" content="Preview &amp; title"></head>`
    ).title,
    'Preview & title'
  );
});

test('falls back through Twitter, meta title and document title', () => {
  assert.equal(
    linkMetadata('<meta name="twitter:title" content="Twitter title">').title,
    'Twitter title'
  );
  assert.equal(linkMetadata('<meta name="title" content="Meta title">').title, 'Meta title');
  assert.equal(
    linkMetadata('<head><title>  Document &#39;title&#39;\n here </title></head>').title,
    "Document 'title' here"
  );
  assert.equal(
    linkMetadata('<head><meta property="og:title" content=" "><title>Fallback</title></head>')
      .title,
    'Fallback'
  );
  assert.equal(linkMetadata('<head></head><title>Body title</title>').title, undefined);
  assert.equal(linkMetadata('<html>No metadata</html>').title, undefined);
});

test('prefers meta description and decodes entities regardless of attribute order', () => {
  assert.equal(
    linkDescription(
      `<head><meta property="og:description" content="Fallback"><meta content='Hello &amp; &#x1f600; world' NAME='description'></head>`
    ),
    'Hello & 😀 world'
  );
});
test('falls back to social descriptions and ignores scripts, comments and body', () => {
  assert.equal(
    linkDescription(
      `<head><!-- <meta name="description" content="Comment"> --><script>'<meta name="description" content="Script">'</script><meta property="og:description" content="Social preview"></head><meta name="description" content="Body">`
    ),
    'Social preview'
  );
  assert.equal(
    linkDescription('<meta name="twitter:description" content="Twitter preview">'),
    'Twitter preview'
  );
  assert.equal(linkDescription('<html>No metadata</html>'), undefined);
});
test('limits excerpts to the first 24 words', () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
  assert.equal(
    linkDescription(`<meta name="description" content="${words.join(' ')}">`),
    `${words.slice(0, 24).join(' ')}…`
  );
});
