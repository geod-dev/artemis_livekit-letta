import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryArtifactSink } from '../test-support.ts';
import { McpResultConverter, MAX_ARTIFACT_BYTES } from './results.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CONVERSATION = 'conv_1';

function converter() {
  const sink = new MemoryArtifactSink();
  return { sink, converter: new McpResultConverter(sink) };
}

/** The JSON envelope is the part after the "Saved to" lines. */
function envelopeOf(text: string): Record<string, unknown> {
  const start = text.indexOf('{\n');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

describe('McpResultConverter.convert', () => {
  test('keeps the whole envelope as text when there is nothing binary', async () => {
    const input = {
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { count: 2 },
      isError: true,
      _meta: { trace: 'abc' },
    };
    const { converter: convert, sink } = converter();
    const result = await convert.convert(input, CONVERSATION);
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.text), input);
    assert.deepEqual(result.artifacts, []);
    assert.equal(sink.saved.length, 0);
  });

  test('array payloads are not treated as result or resource objects', async () => {
    const { converter: convert } = converter();
    const bare = await convert.convert([{ isError: true }], CONVERSATION);
    assert.deepEqual(JSON.parse(bare.text), { content: [] });
    assert.equal(bare.isError, false);
    const result = await convert.convert(
      { content: [{ type: 'resource', resource: [{ uri: 'file:///not-an-object', text: 'ignored' }] }] },
      CONVERSATION
    );
    const envelope = envelopeOf(result.text) as { content: Array<{ resource: unknown }> };
    assert.deepEqual(envelope.content[0]?.resource, [{ uri: 'file:///not-an-object', text: 'ignored' }]);
  });

  test('binary blocks are saved as artifacts, listed by path, and dropped from the envelope', async () => {
    const { converter: convert, sink } = converter();
    const input = {
      content: [
        { type: 'text', text: 'chart' },
        { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///report.json', mimeType: 'application/json', text: '{"ok":true}' } },
      ],
      structuredContent: { count: 2 },
      _meta: { trace: 'abc' },
    };
    const result = await convert.convert(input, CONVERSATION);

    assert.equal(result.artifacts.length, 2);
    const [image, report] = result.artifacts;
    assert.equal(image?.path, `data/artifacts/${CONVERSATION}/mcp-image-2.png`);
    assert.equal(image?.kind, 'image');
    assert.equal(report?.mimeType, 'application/json');
    assert.equal(report?.name, 'report.json');
    assert.deepEqual(sink.saved[0]?.bytes, PNG);
    assert.match(result.text, /^Saved to data\/artifacts\/conv_1\/mcp-image-2\.png\n\nSaved to data\/artifacts\/conv_1\/report\.json/);

    const envelope = envelopeOf(result.text);
    assert.deepEqual(envelope.structuredContent, input.structuredContent);
    assert.deepEqual(envelope._meta, input._meta);
    const content = envelope.content as Array<Record<string, unknown>>;
    assert.equal(content[0]?.text, 'chart');
    assert.equal(content[1]?.data, undefined);
    assert.deepEqual(content[1]?.artifact, image);
    const resource = content[2]?.resource as Record<string, unknown>;
    assert.equal(resource.text, undefined);
    assert.equal(resource.blob, undefined);
    assert.deepEqual(resource.artifact, report);
  });

  test('small images are also inlined for the model; other media types are not', async () => {
    const { converter: convert } = converter();
    const result = await convert.convert(
      {
        content: [
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
          { type: 'audio', data: PNG.toString('base64'), mimeType: 'audio/mpeg' },
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/svg+xml' },
        ],
      },
      CONVERSATION
    );
    assert.deepEqual(result.images, [{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    assert.equal(result.artifacts.length, 3);
    assert.equal(result.artifacts[1]?.path, `data/artifacts/${CONVERSATION}/mcp-audio-2.mp3`);
  });

  test('invalid base64 and oversized resources are refused', async () => {
    const { converter: convert } = converter();
    await assert.rejects(
      convert.convert({ content: [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }] }, CONVERSATION),
      /valid base64/
    );
    await assert.rejects(
      convert.convert(
        { content: [{ type: 'resource', resource: { uri: 'file:///big.txt', text: 'a'.repeat(MAX_ARTIFACT_BYTES + 1) } }] },
        CONVERSATION
      ),
      /larger than 25 MB/
    );
  });

  test('an error result keeps its flag', async () => {
    const { converter: convert } = converter();
    const result = await convert.convert({ content: [{ type: 'text', text: 'no' }], isError: true }, CONVERSATION);
    assert.equal(result.isError, true);
  });
});

describe('McpResultConverter.screenshot', () => {
  test('a device screenshot is saved under the device name and inlined', async () => {
    const { converter: convert, sink } = converter();
    const result = await convert.screenshot(
      { content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: 'ok' }] },
      'laptop',
      CONVERSATION
    );
    assert.match(sink.saved[0]?.name ?? '', /^laptop-.*\.png$/);
    assert.deepEqual(sink.saved[0]?.bytes, PNG);
    assert.equal(result.artifacts[0]?.path.startsWith(`data/artifacts/${CONVERSATION}/laptop-`), true);
    assert.equal(result.images.length, 1);
    assert.match(result.text, /^Screenshot from laptop saved to data\/artifacts\/conv_1\/laptop-/);
    assert.match(result.text, /"text": "ok"/);
  });

  test('a screenshot must be one PNG', async () => {
    const { converter: convert } = converter();
    await assert.rejects(
      convert.screenshot(
        { content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/jpeg' }] },
        'laptop',
        CONVERSATION
      ),
      /valid PNG/
    );
    await assert.rejects(
      convert.screenshot(
        {
          content: [
            { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
            { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
          ],
        },
        'laptop',
        CONVERSATION
      ),
      /only one image/
    );
  });

  test('a result without an image converts like any other result', async () => {
    const { converter: convert } = converter();
    const result = await convert.screenshot({ content: [{ type: 'text', text: 'no screen' }] }, 'laptop', CONVERSATION);
    assert.deepEqual(result.artifacts, []);
    assert.match(result.text, /no screen/);
  });
});
