/**
 * Composition root: the only app module that imports vendor implementations
 * (`@artemis/llm/anthropic`, `@artemis/llm/openai-compatible`,
 * `@artemis/storage/postgres`, `@artemis/memory/hindsight`,
 * `@artemis/workspace/filesystem`, `@artemis/mcp/sdk`). `compose(config)` makes
 * every vendor-or-no-op choice and returns the port set; `main.ts` only wires
 * lifecycle around it. Every other module receives the interfaces by parameter.
 */
import { type LlmProvider, ProviderRegistry } from '@artemis/llm';
import { AnthropicLlmProvider } from '@artemis/llm/anthropic';
import { OpenAiCompatibleLlmProvider } from '@artemis/llm/openai-compatible';
import type { MemoryStore } from '@artemis/memory';
import { HindsightMemoryStore } from '@artemis/memory/hindsight';
import { McpCatalog, McpServerRegistry, type McpSettingsStore, mcpRevision } from '@artemis/mcp';
import { SdkMcpClient } from '@artemis/mcp/sdk';
import type { Storage } from '@artemis/storage';
import { PostgresStorage } from '@artemis/storage/postgres';
import type { WorkspaceTransport } from '@artemis/workspace';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import { workspaceArtifactSink } from './artifacts/workspace-artifact-sink.ts';
import { type AgentServerConfig, WORKSPACE_RIPGREP } from './config.ts';
import { createModelRouter, type ModelRouter } from './models/routing.ts';
import { NoopMemoryStore } from './memory/noop-memory-store.ts';

/** Every implementation the service runs on; main.ts and the runtime receive these, never a vendor type. */
export interface ComposedPorts {
  storage: Storage;
  router: ModelRouter;
  memoryStore: MemoryStore;
  workspace: WorkspaceTransport;
  mcpClient: SdkMcpClient;
  catalog: McpCatalog;
  registry: McpServerRegistry;
}

export function compose(config: AgentServerConfig): ComposedPorts {
  const storage = new PostgresStorage({ connectionString: config.databaseUrl });
  const router = createModelRouter(config, createProviders(config));

  // Memory: Hindsight when configured; otherwise a store that recalls nothing and retains nowhere.
  const memoryStore: MemoryStore = config.memory.enabled
    ? new HindsightMemoryStore({
        baseUrl: config.memory.hindsightUrl,
        apiKey: config.memory.hindsightApiKey,
        bankId: config.memory.bankId,
      })
    : new NoopMemoryStore();

  const workspace = new FilesystemWorkspaceTransport({
    root: config.workspace.root,
    displayRoot: config.workspace.displayRoot,
    runAs: config.workspace.runAs,
    ripgrep: WORKSPACE_RIPGREP,
  });

  // MCP: manual servers in storage, device servers pushed by the gateway, catalog refreshed on change.
  const mcpClient = new SdkMcpClient({
    artifacts: workspaceArtifactSink(workspace),
    stdio: { cwd: config.workspace.root },
  });
  const { catalog, registry } = wireMcp(storage, mcpClient);

  return { storage, router, memoryStore, workspace, mcpClient, catalog, registry };
}

function createProviders(config: AgentServerConfig): ProviderRegistry {
  const providers: LlmProvider[] = [new AnthropicLlmProvider({ apiKey: config.providers.anthropicApiKey })];
  if (config.providers.openAiCompatible) {
    providers.push(new OpenAiCompatibleLlmProvider(config.providers.openAiCompatible));
  }
  return new ProviderRegistry(providers);
}

/**
 * The registry pushes changes to the catalog, and the catalog reads the server list from the
 * registry. The registry is built first; its callbacks reach the catalog through `link`, which is
 * filled once the catalog exists, so no closure reads a variable declared after it.
 */
function wireMcp(storage: Storage, client: SdkMcpClient): { catalog: McpCatalog; registry: McpServerRegistry } {
  const link: { catalog?: McpCatalog } = {};
  const linkedCatalog = (): McpCatalog => {
    if (!link.catalog) throw new Error('MCP catalog is not wired');
    return link.catalog;
  };
  const registry = new McpServerRegistry(
    mcpSettingsStore(storage),
    () => linkedCatalog().refresh().then(() => undefined),
    () => linkedCatalog().status()
  );
  const catalog = new McpCatalog(client, () => registry.servers());
  link.catalog = catalog;
  return { catalog, registry };
}

function mcpSettingsStore(storage: Storage): McpSettingsStore {
  return {
    async load() {
      const record = await storage.mcpSettings.get();
      return record
        ? { servers: record.servers, invalidEntries: record.invalidEntries, revision: record.revision }
        : { servers: [], invalidEntries: [], revision: null };
    },
    async save(servers, invalidEntries, expectedRevision) {
      const revision = mcpRevision(servers);
      const record = await storage.mcpSettings.save({ servers, invalidEntries, revision }, expectedRevision);
      return record.revision;
    },
  };
}
