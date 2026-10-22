// A minimal stdio MCP server for the SdkMcpClient tests (spawned by the test, never imported).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// PNG signature only: enough for the client, which does not decode images.
const PNG_BASE64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'picture',
      description: 'Return a small image.',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    },
    { name: 'save_note', description: 'Write a note.', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args.text ?? '') }] };
    case 'picture':
      return { content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] };
    default:
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
