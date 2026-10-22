import { createHash } from 'node:crypto';
import type { McpServer, McpTransport } from '@artemis/contracts/chat-types';

export type { McpServer, McpTransport };

/** A payload we refuse to store. Surfaced to callers as a 400. */
export class InvalidMcpServersError extends Error {
  constructor(
    message: string,
    readonly entries: Array<{ index: number; diagnostic: string; value: unknown }> = []
  ) {
    super(message);
    this.name = 'InvalidMcpServersError';
  }
}

export interface InvalidMcpEntry {
  index: number;
  value: unknown;
  diagnostic: string;
}

/** Shared MCP list limit (manual servers only; device servers come from connections). */
export const MAX_MCP_SERVERS = 100;

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key.trim().length > 0 && !/[\r\n]/.test(key) && typeof entry === 'string' && !/[\r\n]/.test(entry)
  );
}

/**
 * Validate one server entry and normalise it for storage. The transport decides
 * what is required; a field the editor does not set is omitted rather than
 * stored empty. Refused: a nameless server, an unknown transport, a stdio server
 * with no command, a remote server with no URL, non-string env/header values.
 */
function validateServer(value: unknown, index: number): McpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidMcpServersError(`Server ${index} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['name', 'transport', 'command', 'args', 'url', 'env', 'headers', 'managed']);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) throw new InvalidMcpServersError(`Server ${index} has an unsupported field: ${extra}`);
  if (raw.managed !== undefined) {
    throw new InvalidMcpServersError('Connected devices cannot be edited in MCP settings');
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new InvalidMcpServersError(`Server ${index} has no name`);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    // The name is the tool namespace, `mcp__<name>__<tool>`.
    throw new InvalidMcpServersError(`Server "${name}": use letters, digits, "-" and "_" only in a name`);
  }

  const transport = (typeof raw.transport === 'string' ? raw.transport : 'stdio') as McpTransport;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    throw new InvalidMcpServersError(`Server "${name}" has an unknown transport: ${transport}`);
  }

  const server: McpServer = { name, transport };

  if (transport === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) throw new InvalidMcpServersError(`Server "${name}" has no command`);
    server.command = command;
    if (raw.args !== undefined && !Array.isArray(raw.args)) {
      throw new InvalidMcpServersError(`Server "${name}" arguments must be an array`);
    }
    if (Array.isArray(raw.args)) {
      if (!raw.args.every((arg) => typeof arg === 'string')) {
        throw new InvalidMcpServersError(`Server "${name}" has non-string arguments`);
      }
      if (raw.args.length > 0) server.args = raw.args as string[];
    }
  } else {
    if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined) {
      throw new InvalidMcpServersError(`Server "${name}" has stdio-only fields for a remote transport`);
    }
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url) throw new InvalidMcpServersError(`Server "${name}" has no url`);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw new InvalidMcpServersError(`Server "${name}" has an invalid url: ${url}`);
    }
    server.url = url;
  }

  if (raw.env !== undefined) {
    if (!isStringRecord(raw.env)) {
      throw new InvalidMcpServersError(`Server "${name}" has non-string env values`);
    }
    if (Object.keys(raw.env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      throw new InvalidMcpServersError(`Server "${name}" has an invalid env variable name`);
    }
    if (Object.keys(raw.env).length > 0) server.env = raw.env;
  }
  if (raw.headers !== undefined) {
    if (!isStringRecord(raw.headers)) {
      throw new InvalidMcpServersError(`Server "${name}" has non-string header values`);
    }
    if (Object.keys(raw.headers).some((key) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))) {
      throw new InvalidMcpServersError(`Server "${name}" has an invalid HTTP header name`);
    }
    if (Object.keys(raw.headers).length > 0) server.headers = raw.headers;
  }
  return server;
}

/** Validate a whole list (the editor's PUT body) and return normalised copies. Throws on the first problem. */
export function validateMcpServers(value: unknown): McpServer[] {
  if (!Array.isArray(value)) throw new InvalidMcpServersError('servers must be an array');
  if (value.length > MAX_MCP_SERVERS) {
    throw new InvalidMcpServersError(`At most ${MAX_MCP_SERVERS} MCP servers can be configured`);
  }
  const servers = value.map(validateServer);
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) throw new InvalidMcpServersError(`Duplicate server name: ${server.name}`);
    names.add(server.name);
  }
  return servers;
}

/**
 * Lenient read of stored entries: valid servers stay operational, malformed or
 * duplicate entries are returned with their diagnostic so they can be shown and
 * preserved instead of silently dropped.
 */
export function readMcpEntries(entries: readonly unknown[]): {
  servers: McpServer[];
  invalidEntries: InvalidMcpEntry[];
} {
  const servers: McpServer[] = [];
  const invalidEntries: InvalidMcpEntry[] = [];
  const names = new Set<string>();
  entries.forEach((entry, index) => {
    try {
      const server = validateServer(entry, index);
      if (names.has(server.name)) throw new InvalidMcpServersError(`Duplicate server name: ${server.name}`);
      names.add(server.name);
      servers.push(server);
    } catch (error) {
      invalidEntries.push({ index, value: entry, diagnostic: messageOf(error) });
    }
  });
  return { servers, invalidEntries };
}

/** Why a stored entry is not operational (for diagnostics). */
export function describeInvalidEntry(value: unknown): string {
  try {
    validateServer(value, 0);
    return 'Stored entry is not operational';
  } catch (error) {
    return messageOf(error);
  }
}

/** sha256 of the canonical JSON of the list (object keys sorted): the `revision` / ETag. */
export function mcpRevision(servers: readonly McpServer[]): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(servers))).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortKeys(record[key])])
    );
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
