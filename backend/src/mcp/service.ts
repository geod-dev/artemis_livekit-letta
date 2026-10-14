import { MCP_SETTINGS_PATH, type McpServer, readMcpSettings, renderMcpSettings } from './settings';
import { MCP_SKILL_DIR, MCP_SKILL_NAME, renderMcpSkill } from './skill';

/**
 * Everything the MCP store touches, all of it through the Letta server: the
 * files live in its `letta-data` volume, not on the backend's host.
 */
export interface McpIo {
  /** File content, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** `skill_enable`: symlink a skill directory into the global skills dir. */
  enableSkill(path: string): Promise<void>;
  /** `skill_disable`: unlink it again. "Not found" is success. */
  disableSkill(name: string): Promise<void>;
}

/** The configured servers. A missing file reads as an empty list. */
export async function loadMcpServers(io: McpIo): Promise<McpServer[]> {
  const raw = await io.read(MCP_SETTINGS_PATH);
  return raw === null ? [] : readMcpSettings(raw).servers;
}

export async function loadMcpSettings(io: McpIo) {
  const raw = await io.read(MCP_SETTINGS_PATH);
  return {
    raw,
    ...(raw === null ? { servers: [], invalidEntries: [] } : readMcpSettings(raw)),
  };
}

/** Write the list, then bring the skill in line with it. */
export async function saveMcpServers(
  io: McpIo,
  servers: McpServer[]
): Promise<{ skill: 'synced' | 'failed'; error?: string }> {
  const previous = await loadMcpSettings(io);
  await io.write(
    MCP_SETTINGS_PATH,
    renderMcpSettings(
      servers,
      previous.invalidEntries.map((entry) => entry.value)
    )
  );
  try {
    await syncMcpSkill(io, servers);
    return { skill: 'synced' };
  } catch (error) {
    return {
      skill: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run on every connect to the Letta server: create the settings file (empty)
 * on a fresh volume, and re-render the skill either way, so a deploy always
 * leaves the current wrapper and wording in place. Returns the servers now
 * configured.
 */
async function syncMcpSkill(io: McpIo, servers: McpServer[]): Promise<void> {
  if (servers.length === 0) {
    await io.disableSkill(MCP_SKILL_NAME);
    return;
  }
  const parent = MCP_SKILL_DIR.slice(0, MCP_SKILL_DIR.lastIndexOf('/'));
  for (const file of renderMcpSkill(servers)) {
    await io.write(`${parent}/${file.path}`, file.content);
  }
  await io.enableSkill(MCP_SKILL_DIR);
}
