import type { McpServer, McpTransport } from '@shared/chat-types';

/** The editor's form: free text where the server stores lists and maps. */
export interface McpServerDraft {
  name: string;
  transport: McpTransport;
  command: string;
  /** JSON array, preserving spaces and quotes inside arguments. */
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

/** `KEY=value` / `Name: value` lines. Malformed nonblank lines are rejected. */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    const at = line.indexOf(separator);
    if (at <= 0)
      throw new Error(
        `Line ${index + 1} must contain ${separator === '=' ? 'KEY=value' : 'Name: value'}.`
      );
    const key = line.slice(0, at).trim();
    if (!key) throw new Error(`Line ${index + 1} has an empty name.`);
    if (Object.hasOwn(pairs, key)) throw new Error(`Line ${index + 1} repeats ${key}.`);
    pairs[key] = line.slice(at + 1).trim();
  }
  return pairs;
}

export function toDraft(server: McpServer): McpServerDraft {
  return {
    name: server.name,
    transport: server.transport ?? 'stdio',
    command: server.command ?? '',
    args: JSON.stringify(server.args ?? [], null, 2),
    url: server.url ?? '',
    env: formatPairs(server.env, '='),
    headers: formatPairs(server.headers, ': '),
  };
}

/** The server to save; fields of the other transport are left out. */
export function fromDraft(draft: McpServerDraft): McpServer {
  const server: McpServer = {
    name: draft.name.trim(),
    transport: draft.transport,
  };
  if (isRemote(draft.transport)) {
    server.url = draft.url.trim();
    const headers = parsePairs(draft.headers, ':');
    if (Object.keys(headers).length > 0) server.headers = headers;
  } else {
    server.command = draft.command.trim();
    const args: unknown = JSON.parse(draft.args || '[]');
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      throw new Error('Arguments must be a JSON array of strings.');
    }
    if (args.length > 0) server.args = args;
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
