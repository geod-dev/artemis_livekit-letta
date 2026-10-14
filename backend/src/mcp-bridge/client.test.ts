import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../assistant/config.ts';
import { adaptListedTool, artifactizeResult, textOfResult } from './client.ts';

test('textOfResult keeps text, structured values, media, resources, and error metadata', () => {
  const input = {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'YWJj', mimeType: 'image/png' },
      {
        type: 'resource',
        resource: { uri: 'file:///result.txt', text: 'body' },
      },
    ],
    structuredContent: { count: 2 },
    isError: true,
    _meta: { trace: 'abc' },
    experimental: { cursor: 'next' },
  };
  const result = textOfResult(input);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.text), input);
});

test('array payloads are not treated as MCP result or resource objects', async () => {
  assert.equal(textOfResult([{ isError: true }]).text, '{}');
  const result = await artifactizeResult({
    content: [{ type: 'resource', resource: [{ uri: 'file:///not-an-object', text: 'ignored' }] }],
  });
  const envelope = JSON.parse(result.text) as { content: Array<{ resource: unknown }> };
  assert.deepEqual(envelope.content[0]?.resource, [
    { uri: 'file:///not-an-object', text: 'ignored' },
  ]);
});

test('listed tools validate the SDK payload shape before entering the catalog', () => {
  assert.equal(adaptListedTool([{ name: 'wrong' }]), null);
  assert.deepEqual(
    adaptListedTool({ name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }),
    { name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
  );
  assert.throws(() => adaptListedTool({ name: 'lookup', inputSchema: [] }), /invalid input schema/);
  assert.throws(() => adaptListedTool({ name: 'lookup', annotations: { readOnlyHint: 'yes' } }), /invalid read-only annotation/);
});

test('artifactizeResult saves media bytes and retains the MCP result envelope', async () => {
  const previous = config.workspace.dir;
  const root = await mkdtemp(join(process.cwd(), '.test-mcp-artifact-'));
  config.workspace.dir = root;
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const input = {
      content: [
        { type: 'text', text: 'chart' },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///report.json', mimeType: 'application/json', text: '{"ok":true}' } },
      ],
      structuredContent: { count: 2 },
      isError: false,
      _meta: { trace: 'abc' },
    experimental: { cursor: 'next' },
    };
    const result = await artifactizeResult(input);
    const jsonStart = result.text.indexOf('{\n  "content"');
    assert.ok(jsonStart >= 0);
    const envelope = JSON.parse(result.text.slice(jsonStart)) as Record<string, unknown>;
    assert.deepEqual(envelope.structuredContent, input.structuredContent);
    assert.deepEqual(envelope._meta, input._meta);
    assert.deepEqual(envelope.experimental, input.experimental);
    assert.equal((envelope.content as Array<Record<string, unknown>>)[0]?.text, 'chart');
    const image = (envelope.content as Array<Record<string, unknown>>)[1]!;
    const imageArtifact = image.artifact as { path: string; kind: string; mimeType: string };
    assert.equal(imageArtifact.kind, 'image');
    assert.equal(imageArtifact.mimeType, 'image/png');
    assert.deepEqual(await readFile(join(root, imageArtifact.path)), png);
    const resource = (envelope.content as Array<Record<string, unknown>>)[2]!.resource as {
      artifact: { path: string; mimeType: string };
      text?: string;
    };
    assert.equal(resource.text, undefined);
    assert.equal(resource.artifact.mimeType, 'application/json');
    assert.match(result.text, /Saved to \/api\/workspace\//);
    assert.match(result.text, /^\[\[mcp-managed-artifacts:v1:[0-9a-f-]{36}\]\]/i);
  } finally {
    config.workspace.dir = previous;
    await rm(root, { recursive: true, force: true });
  }
});
