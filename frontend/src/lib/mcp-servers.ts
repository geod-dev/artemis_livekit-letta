import type { McpServer, McpTransport } from '@backend/chat-types';

/** The editor's form: free text where the server stores lists and maps. */
export interface McpServerDraft {
  name: string;
  transport: McpTransport;
  command: string;
  /** Space separated. */
  args: string;
  url: string;
  /** One `KEY=value` per line (stdio). */
  env: string;
  /** One `Name: value` per line (http, sse). */
  headers: string;
}

export const BLANK_DRAFT: McpServerDraft = {
  name: '',
  transport: 'http',
  command: '',
  args: '',
  url: '',
  env: '',
  headers: '',
};

export function isRemote(transport: McpTransport | undefined): boolean {
  return transport === 'http' || transport === 'sse';
}

function formatPairs(pairs: Record<string, string> | undefined, separator: string): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n');
}

/** `KEY=value` / `Name: value` lines; blank lines and lines without the separator are skipped. */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) pairs[key] = line.slice(at + 1).trim();
  }
  return pairs;
}

export function toDraft(server: McpServer): McpServerDraft {
  return {
    name: server.name,
    transport: server.transport ?? 'stdio',
    command: server.command ?? '',
    args: (server.args ?? []).join(' '),
    url: server.url ?? '',
    env: formatPairs(server.env, '='),
    headers: formatPairs(server.headers, ': '),
  };
}

/** The server to save; fields of the other transport are left out. */
export function fromDraft(draft: McpServerDraft): McpServer {
  const server: McpServer = { name: draft.name.trim(), transport: draft.transport };
  if (isRemote(draft.transport)) {
    server.url = draft.url.trim();
    const headers = parsePairs(draft.headers, ':');
    if (Object.keys(headers).length > 0) server.headers = headers;
  } else {
    server.command = draft.command.trim();
    const args = draft.args.trim();
    if (args) server.args = args.split(/\s+/);
    const env = parsePairs(draft.env, '=');
    if (Object.keys(env).length > 0) server.env = env;
  }
  return server;
}

/** One line for the list: where the server is, never its secrets. */
export function describeServer(server: McpServer): string {
  const transport = server.transport ?? 'stdio';
  return isRemote(transport)
    ? `${transport} · ${server.url ?? ''}`
    : `stdio · ${[server.command ?? '', ...(server.args ?? [])].join(' ')}`;
}
