/**
 * The shared MCP server list, and the settings file `letta mcp` reads it from.
 *
 * Letta keeps MCP servers per agent in `/root/.letta/settings.json`, and that
 * file is unusable for us: the server holds it in memory and rewrites the
 * whole `agents` array from that copy whenever any agent setting changes
 * (agent create, memfs, toolset, system-prompt versioning), which silently
 * drops entries written from outside, and `reload` never re-reads it.
 *
 * So the servers live in a settings file of their own, under a home directory
 * the server never loads: `letta mcp`, run from an agent's shell with
 * `HOME=MCP_HOME` (the `mcp-servers` skill's wrapper does that), reads it fresh
 * on every call. One synthetic agent id holds the list, which makes it global:
 * every agent passes the same `--agent`.
 *
 * The backend owns this file outright, so it is rendered whole, never merged.
 * The design follows lettuce (github.com/dmarcelino/lettuce, bff/src/mcp/).
 */
import type { McpServer, McpTransport } from '../chat-types';

export type { McpServer, McpTransport };

/** `HOME` for `letta mcp`: inside the `letta-data` volume, so it persists. */
export const MCP_HOME = '/root/.letta/mcp-home';
export const MCP_SETTINGS_PATH = `${MCP_HOME}/.letta/settings.json`;

/**
 * The agent id the list is stored under. Nothing checks that it exists; the
 * `agent-local-` prefix keeps it compatible with Letta's local-mode id checks.
 */
export const GLOBAL_MCP_AGENT = 'agent-local-mcp-global';

/**
 * `getAgentSettings` matches `baseUrl` as well as `agentId`, and in local mode
 * the key is `local:<LETTA_LOCAL_BACKEND_DIR>`. Letta sets that variable for
 * every agent shell to its own storage directory (the default under
 * `/root/.letta`), so an entry without this key is invisible to `letta mcp`.
 */
export const LOCAL_BACKEND_DIR = '/root/.letta/lc-local-backend';
export const LOCAL_BASE_URL = `local:${LOCAL_BACKEND_DIR}`;

/** A settings file we cannot parse is not something to show or overwrite. */
export class SettingsUnreadableError extends Error {}

/** A payload we refuse to write. Surfaced to the caller as a 400. */
export class InvalidMcpServersError extends Error {}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Validate one server entry and normalise it for writing. The transport
 * decides what is required; a field the editor does not set is omitted rather
 * than written empty. Refused: a nameless server, an unknown transport, a stdio
 * server with no command, a remote server with no URL, non-string env/header
 * values.
 */
function validateServer(value: unknown, index: number): McpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidMcpServersError(`Server ${index} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.managed !== undefined) {
    throw new InvalidMcpServersError('Connected devices cannot be edited in MCP settings');
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new InvalidMcpServersError(`Server ${index} has no name`);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    // The name is the tool namespace, `mcp__<name>__<tool>`.
    throw new InvalidMcpServersError(
      `Server "${name}": use letters, digits, "-" and "_" only in a name`
    );
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
    if (Array.isArray(raw.args)) {
      if (!raw.args.every((arg) => typeof arg === 'string')) {
        throw new InvalidMcpServersError(`Server "${name}" has non-string arguments`);
      }
      if (raw.args.length > 0) server.args = raw.args as string[];
    }
  } else {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url) throw new InvalidMcpServersError(`Server "${name}" has no url`);
    try {
      new URL(url);
    } catch {
      throw new InvalidMcpServersError(`Server "${name}" has an invalid url: ${url}`);
    }
    server.url = url;
  }

  if (raw.env !== undefined) {
    if (!isStringRecord(raw.env)) {
      throw new InvalidMcpServersError(`Server "${name}" has non-string env values`);
    }
    if (Object.keys(raw.env).length > 0) server.env = raw.env;
  }
  if (raw.headers !== undefined) {
    if (!isStringRecord(raw.headers)) {
      throw new InvalidMcpServersError(`Server "${name}" has non-string header values`);
    }
    if (Object.keys(raw.headers).length > 0) server.headers = raw.headers;
  }
  return server;
}

/** Validate a whole list and return normalised copies. */
export function validateMcpServers(value: unknown): McpServer[] {
  if (!Array.isArray(value)) throw new InvalidMcpServersError('servers must be an array');
  const servers = value.map(validateServer);
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new InvalidMcpServersError(`Duplicate server name: ${server.name}`);
    }
    names.add(server.name);
  }
  return servers;
}

/**
 * The whole settings file for `letta mcp`.
 *
 * `autoConversationTitlesRollbackApplied: true` is load-bearing: without it
 * `settingsManager.initialize()` runs a one-time migration and persists, so
 * every agent's `letta mcp` call would rewrite this file, racing the backend's
 * own writes. With it set, the CLI only ever reads.
 */
export function renderMcpSettings(servers: McpServer[]): string {
  const settings = {
    autoConversationTitles: false,
    autoConversationTitlesRollbackApplied: true,
    agents: [{ agentId: GLOBAL_MCP_AGENT, baseUrl: LOCAL_BASE_URL, mcpServers: servers }],
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * The configured servers, as written. Returned unvalidated on purpose:
 * refusing to display a server that is on disk would hide it rather than show
 * it. Validation happens on write.
 */
export function readMcpServers(raw: string): McpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsUnreadableError(
      `${MCP_SETTINGS_PATH} is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsUnreadableError(`${MCP_SETTINGS_PATH} is not a JSON object`);
  }
  const agents = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  const entry = agents.find(
    (agent) =>
      Boolean(agent) &&
      typeof agent === 'object' &&
      (agent as { agentId?: unknown }).agentId === GLOBAL_MCP_AGENT
  ) as { mcpServers?: unknown } | undefined;
  if (!Array.isArray(entry?.mcpServers)) return [];
  return entry.mcpServers.filter(
    (server): server is McpServer => Boolean(server) && typeof server === 'object'
  );
}
