import { assistant } from '../assistant/letta';
import {
  isLettaServerReady,
  lettaServerRequest,
  onLettaServerConnected,
  readLettaFile,
  writeLettaFile,
} from '../assistant/letta-server';
import { type ModsIo, syncMods } from '../internal-tools/install';
import { renderToolsMod } from '../internal-tools/mod';
import type { ToolHandler } from '../internal-tools/types';
import { McpCatalog } from '../mcp-bridge/catalog';
import { mcpClient } from '../mcp-bridge/client';
import { BRIDGE_TOOL_SPECS, MCP_BRIDGE_MOD_PATH, bridgeHandlers } from '../mcp-bridge/tools';
import { type McpIo, ensureMcpServers, loadMcpServers, saveMcpServers } from './service';
import type { McpServer } from './settings';

/**
 * The shared MCP list (Settings -> MCP servers) and the native tools over it.
 *
 * Everything goes through the Letta server: the list and the `mcp-servers`
 * skill are files in its volume (`service.ts`), and the MCP bridge is a mod
 * there (`mcp-bridge/`) whose tools call this backend back. On every connect
 * the skill and the mod are re-rendered, so a fresh volume or a new backend
 * version needs nothing by hand.
 */

const log = (message: string) => console.info(`[mcp] ${message}`);

const mcpIo: McpIo = {
  read: readLettaFile,
  write: writeLettaFile,
  async enableSkill(skillPath) {
    const response = await lettaServerRequest({ type: 'skill_enable', skill_path: skillPath });
    if (response.success !== true) throw new Error(response.error ?? 'skill_enable failed');
  },
  async disableSkill(name) {
    const response = await lettaServerRequest({ type: 'skill_disable', name });
    // Nothing linked is the state we want, not a failure.
    if (response.success !== true && !/not found/i.test(response.error ?? '')) {
      throw new Error(response.error ?? 'skill_disable failed');
    }
  },
};

const modsIo: ModsIo = {
  read: readLettaFile,
  write: writeLettaFile,
  // `reload` needs an agent runtime to run in; it reloads the global mods for
  // the whole server, whichever agent it names.
  async reloadMods() {
    const { agentId } = await assistant();
    const response = await lettaServerRequest<{
      type: string;
      success?: boolean;
      output?: string;
    }>({
      type: 'execute_command',
      command_id: 'reload',
      runtime: { agent_id: agentId, conversation_id: 'default' },
    });
    if (!response.success) throw new Error(response.output || 'reload failed');
    return true;
  },
};

export const mcpCatalog = new McpCatalog({
  servers: () => loadMcpServers(mcpIo),
  client: mcpClient,
  log,
});

/** The native tools the backend serves to its mods (`/api/letta/tools/<name>`). */
export const toolHandlers: ReadonlyMap<string, ToolHandler> = bridgeHandlers(mcpCatalog, mcpClient);

// Serialised: a save and a reconnect can land at once.
let modsChain: Promise<unknown> = Promise.resolve();

/** Re-render the bridge mod (tools only while some server lists tools) and reload it. */
function resyncMods(reason: string, options: { refreshCatalog: boolean }): Promise<void> {
  const run = modsChain.then(async () => {
    if (!isLettaServerReady()) return;
    if (options.refreshCatalog) await mcpCatalog.refresh();
    const { tools } = mcpCatalog.snapshot();
    const result = await syncMods(modsIo, [
      {
        path: MCP_BRIDGE_MOD_PATH,
        source: renderToolsMod({
          title: 'mcp-bridge v1',
          tools: tools.length > 0 ? BRIDGE_TOOL_SPECS : [],
        }),
      },
    ]);
    if (result !== 'unchanged') log(`bridge mod ${result} (${reason})`);
  });
  modsChain = run.catch((error) => log(`could not sync the bridge mod: ${errorMessage(error)}`));
  return run;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bring the shared list's skill and the bridge mod in line on every connect. */
export function startMcp(): void {
  onLettaServerConnected(() => {
    void ensureMcpServers(mcpIo)
      .then((servers) => log(`${servers.length} shared server(s) configured`))
      .catch((error) => log(`could not sync shared servers: ${errorMessage(error)}`))
      .then(() => resyncMods('connected', { refreshCatalog: true }))
      .catch(() => {});
  });
}

export function getMcpServers(): Promise<McpServer[]> {
  return loadMcpServers(mcpIo);
}

/**
 * Save the list. The file needs no reload (the next `letta mcp` call and the
 * next turn's skill listing read it from disk), but the bridge's catalog and
 * its mod do.
 */
export async function setMcpServers(servers: McpServer[]): Promise<void> {
  await saveMcpServers(mcpIo, servers);
  // Awaited so the answer carries the new catalog; a failed reload is logged, not the save's error.
  await resyncMods('Settings -> MCP servers', { refreshCatalog: true }).catch(() => {});
}
