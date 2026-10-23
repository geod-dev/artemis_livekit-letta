/**
 * Composition root: the only app module that imports vendor implementations
 * (`@artemis/llm/anthropic`, `@artemis/llm/openai-compatible`,
 * `@artemis/storage/postgres`, `@artemis/memory/hindsight`,
 * `@artemis/workspace/filesystem`, `@artemis/mcp/sdk`). Every other module
 * receives the interfaces these factories return, by parameter or context.
 */
import { AnthropicLlmProvider, type AnthropicProviderOptions } from '@artemis/llm/anthropic';
import { OpenAiCompatibleLlmProvider, type OpenAiCompatibleProviderOptions } from '@artemis/llm/openai-compatible';
import { HindsightMemoryStore, type HindsightMemoryOptions } from '@artemis/memory/hindsight';
import { SdkMcpClient, type SdkMcpClientOptions } from '@artemis/mcp/sdk';
import { PostgresStorage, type PostgresStorageOptions } from '@artemis/storage/postgres';
import { FilesystemWorkspaceTransport, type FilesystemWorkspaceOptions } from '@artemis/workspace/filesystem';

export const compose = {
  anthropicProvider: (options: AnthropicProviderOptions) => new AnthropicLlmProvider(options),
  openAiCompatibleProvider: (options: OpenAiCompatibleProviderOptions) => new OpenAiCompatibleLlmProvider(options),
  hindsightMemory: (options: HindsightMemoryOptions) => new HindsightMemoryStore(options),
  postgresStorage: (options: PostgresStorageOptions) => new PostgresStorage(options),
  filesystemWorkspace: (options: FilesystemWorkspaceOptions) => new FilesystemWorkspaceTransport(options),
  sdkMcpClient: (options: SdkMcpClientOptions) => new SdkMcpClient(options),
};
