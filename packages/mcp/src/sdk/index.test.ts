import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@artemis/contracts/chat-types';
import { MemoryArtifactSink } from '../test-support.ts';
import { SdkMcpClient, adaptListedTool } from './index.ts';

describe('adaptListedTool', () => {
  test('rejects a non-object or unnamed entry without failing the whole listing', () => {
    assert.equal(adaptListedTool([{ name: 'wrong' }]), null);
    assert.equal(adaptListedTool({ name: '   ' }), null);
  });

  test('keeps the subset the bridge uses', () => {
    assert.deepEqual(
      adaptListedTool({
        name: 'lookup',
        description: 'Look it up.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, title: 'ignored' },
        extra: 'ignored',
      }),
      {
        name: 'lookup',
        description: 'Look it up.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      }
    );
  });

  test('refuses malformed schema, annotation and description values', () => {
    assert.throws(() => adaptListedTool({ name: 'lookup', inputSchema: [] }), /invalid input schema/);
    assert.throws(
      () => adaptListedTool({ name: 'lookup', annotations: { readOnlyHint: 'yes' } }),
      /invalid read-only annotation/
    );
    assert.throws(() => adaptListedTool({ name: 'lookup', description: 3 }), /invalid description/);
  });
});

describe('SdkMcpClient over stdio', () => {
  const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
  const server: McpServer = { name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture] };

  test('lists tools, calls them, saves images as artifacts, and closes its session', async () => {
    const sink = new MemoryArtifactSink();
    const client = new SdkMcpClient({ artifacts: sink, deadlineMs: 20_000 });
    try {
      const tools = await client.listTools(server);
      assert.deepEqual(
        tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint === true]),
        [
          ['echo', true],
          ['picture', true],
          ['save_note', false],
        ]
      );

      const echo = await client.callTool(server, 'echo', { text: 'hi there' }, { conversationId: 'conv_1' });
      assert.equal(echo.isError, false);
      assert.match(echo.text, /"text": "hi there"/);
      assert.deepEqual(echo.artifacts, []);

      const picture = await client.callTool(server, 'picture', {}, { conversationId: 'conv_1' });
      assert.equal(picture.artifacts[0]?.path, 'data/artifacts/conv_1/mcp-image-1.png');
      assert.equal(picture.images.length, 1);
      assert.equal(picture.images[0]?.mediaType, 'image/png');
      assert.equal(sink.saved[0]?.bytes.length, 16);

      const unknown = await client.callTool(server, 'save_note', {}, { conversationId: 'conv_1' });
      assert.equal(unknown.isError, true);
    } finally {
      await client.close();
    }
  });

  test('a server that cannot be started is an error, not a hang', async () => {
    const client = new SdkMcpClient({ artifacts: new MemoryArtifactSink(), deadlineMs: 20_000 });
    const broken: McpServer = { name: 'broken', transport: 'stdio', command: 'artemis-no-such-binary-xyz' };
    await assert.rejects(client.listTools(broken));
    await client.close();
  });

  test('a stdio server without a command is refused before spawning anything', async () => {
    const client = new SdkMcpClient({ artifacts: new MemoryArtifactSink() });
    await assert.rejects(client.listTools({ name: 'nocommand', transport: 'stdio' }), /has no command/);
  });
});
