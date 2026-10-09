/**
 * Prepare the Letta home before the server starts (run by docker-compose).
 *
 * 1. Install the assistant's subagent definitions (`agents/*.md`) into
 *    ~/.letta/agents, where Letta's native Agent tool discovers them. `${VAR}`
 *    placeholders are filled from the environment; a frontmatter line whose
 *    variable is empty is dropped (e.g. no `model:` means inherit the parent's).
 * 2. Drop per-agent MCP servers from settings.json. MCP servers are one shared
 *    list the backend keeps in its own settings file (Settings -> MCP servers,
 *    see backend/src/mcp/settings.ts): the server rewrites per-agent entries
 *    from memory, so they never were a place to add servers at runtime.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const source = join(import.meta.dirname, 'agents');
const home = join(homedir(), '.letta');

const fill = (text) =>
  text
    .split('\n')
    .flatMap((line) => {
      const names = [...line.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]);
      if (names.some((name) => !process.env[name]?.trim())) return [];
      return [line.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name].trim())];
    })
    .join('\n');

mkdirSync(join(home, 'agents'), { recursive: true });
for (const file of readdirSync(source).filter((f) => f.endsWith('.md'))) {
  writeFileSync(join(home, 'agents', file), fill(readFileSync(join(source, file), 'utf8')));
  console.log(`[setup] subagent ${file}`);
}

const settingsFile = join(home, 'settings.json');
if (existsSync(settingsFile)) {
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const agents = (settings.agents ?? []).filter((agent) => agent.mcpServers);
  for (const agent of agents) delete agent.mcpServers;
  if (agents.length > 0) {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    console.log(`[setup] dropped per-agent MCP servers of ${agents.length} agents`);
  }
}
