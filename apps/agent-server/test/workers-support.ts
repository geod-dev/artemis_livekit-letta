import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, Logger } from '@artemis/core';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import { McpCatalog, McpClient } from '@artemis/mcp';
import {
  type AssistantContent,
  LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
  type ModelInfo,
  type ModelRoute,
  type StopReason,
} from '@artemis/llm';
import { EphemeralStorage } from '@artemis/storage/testing';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import { type AgentServerConfig, WORKSPACE_RIPGREP } from '../src/config.ts';
import { createCallSessions } from '../src/calls/call-sessions.ts';
import { ConversationEventHub } from '../src/events/hub.ts';
import type { MemoryCoordinator } from '../src/memory/coordinator.ts';
import type { ModelRouter, RouteKind } from '../src/models/routing.ts';
import { PromptRenderer } from '../src/prompts/renderer.ts';
import type { TitleService } from '../src/titles/title-service.ts';
import { type AgentRuntime, createAgentRuntime } from '../src/workers/wiring.ts';
import type { WorkerSupervisor } from '../src/workers/supervisor.ts';

/** Resolves once every background task end, delivery and wake started so far has finished. */
export async function settled(supervisor: WorkerSupervisor): Promise<void> {
  while (supervisor.inFlight().length > 0) await Promise.allSettled([...supervisor.inFlight()]);
}

/** The filesystem workspace of a test config, built without opening storage or the MCP client. */
export function testWorkspace(config: AgentServerConfig): FilesystemWorkspaceTransport {
  return new FilesystemWorkspaceTransport({
    root: config.workspace.root,
    displayRoot: config.workspace.displayRoot,
    runAs: config.workspace.runAs,
    ripgrep: WORKSPACE_RIPGREP,
  });
}

/** Test clock: `advance` moves time; timers are real (their delays are short in tests). */
export class ManualClock implements Clock {
  private time = Date.parse('2026-10-22T10:00:00Z');

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  }

  setInterval(fn: () => void, ms: number): { cancel(): void } {
    const handle = setInterval(fn, ms);
    return { cancel: () => clearInterval(handle) };
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export interface Step {
  content: AssistantContent[];
  stopReason?: StopReason;
  /** Emit the content, then wait for the signal to abort (cancellation tests). */
  hangUntilAbort?: boolean;
}

/** Scripted `LlmProvider`: `respond` picks the step for each model request. */
export class ScriptedProvider extends LlmProvider {
  readonly id = 'anthropic';
  readonly requests: LlmRequest[] = [];

  constructor(private readonly respond: (request: LlmRequest) => Step) {
    super();
  }

  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const step = this.respond(request);
    yield { type: 'message_start', model: request.model };
    let index = 0;
    for (const block of step.content) {
      if (block.type === 'text') {
        yield { type: 'block_start', index, block: 'text' };
        yield { type: 'text_delta', index, text: block.text };
        yield { type: 'block_end', index };
        index += 1;
      } else if (block.type === 'tool_use') {
        yield { type: 'block_start', index, block: 'tool_use', toolUseId: block.id, toolName: block.name };
        yield { type: 'tool_input_delta', index, partialJson: JSON.stringify(block.input) };
        yield { type: 'block_end', index };
        index += 1;
      }
    }
    if (step.hangUntilAbort && signal) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    const hasToolUse = step.content.some((block) => block.type === 'tool_use');
    const stopReason: StopReason = signal?.aborted ? 'aborted' : (step.stopReason ?? (hasToolUse ? 'tool_use' : 'end_turn'));
    yield {
      type: 'message_end',
      message: {
        model: request.model,
        content: step.content,
        stopReason,
        usage: { inputTokens: 10, outputTokens: 5 },
        timings: { startedAt: new Date().toISOString(), durationMs: 1 },
      },
    };
  }

  modelInfo(model: string): ModelInfo {
    return { model, contextWindow: 200_000, maxOutputTokens: 8_000, supportsThinking: false, supportsImages: true };
  }
}

export class FixedRouter implements ModelRouter {
  constructor(private readonly provider: LlmProvider) {}

  route(_kind: RouteKind, options?: { effort?: string; modality?: string }): ModelRoute {
    return {
      provider: this.provider,
      model: 'test-model',
      thinking: 'disabled',
      effort: (options?.effort ?? 'low') as ModelRoute['effort'],
      maxTokens: 1_000,
      showReasoning: false,
      cache: false,
      compaction: false,
    };
  }
}

class FakePrompts extends PromptRenderer {
  constructor(private readonly subagentGate: Promise<unknown> = Promise.resolve()) {
    super('');
  }

  override async system() {
    return { templateId: 'system', templateHash: 'test', systemPrompt: 'MAIN-SYSTEM' };
  }

  /** `subagentGate` holds a subagent start in its spawning phase until it resolves. */
  override async subagent() {
    await this.subagentGate;
    return { templateId: 'agent:general-purpose', templateHash: 'test', systemPrompt: 'SUB-SYSTEM' };
  }
}

export class NoMemory implements MemoryCoordinator {
  async conversationActivated(): Promise<void> {}
  async recallFor(): Promise<[]> {
    return [];
  }
  async recall(): Promise<[]> {
    return [];
  }
  async turnCompleted(): Promise<void> {}
  async flush(): Promise<void> {}
  start(): void {}
  async stop(): Promise<void> {}
}

export class NoTitles implements TitleService {
  request(): Promise<void> {
    return Promise.resolve();
  }
  async stop(): Promise<void> {}
}

export class NoMcp extends McpClient {
  async listTools(): Promise<never[]> {
    return [];
  }
  async callTool(): Promise<never> {
    throw new Error('MCP is not used in these tests');
  }
  async close(): Promise<void> {}
}

export class RecordingHub extends ConversationEventHub {
  readonly events: Array<{ conversationId: string; event: ConversationEvent }> = [];

  override publish(conversationId: string, event: ConversationEvent): void {
    this.events.push({ conversationId, event });
  }

  override publishList(): void {}
}

export function testConfig(workspaceRoot: string, overrides: Partial<AgentServerConfig['workers']> = {}): AgentServerConfig {
  return {
    port: 0,
    token: 'test',
    databaseUrl: '',
    logLevel: 'info',
    assistant: { name: 'Test', timezone: 'Europe/Paris', presentTool: false },
    models: { assistant: 'anthropic/test-model', task: 'anthropic/test-model', title: 'anthropic/test-model' },
    providers: {},
    workspace: { root: workspaceRoot, displayRoot: '/workspace', readOnlyPrefixes: ['data/'] },
    workers: { idleTimeoutMs: 120_000, backgroundAfterMs: 200, maxPendingTurns: 32, maxSubagents: 4, ...overrides },
    memory: {
      enabled: false,
      hindsightUrl: '',
      bankId: 'test',
      retainEvery: 3,
      recallTimeoutMs: { voice: 1500, text: 4000 },
      recallMaxTokens: { low: 800, mid: 1500, high: 3000 },
    },
  };
}

export interface Harness {
  storage: EphemeralStorage;
  hub: RecordingHub;
  clock: ManualClock;
  provider: ScriptedProvider;
  runtime: AgentRuntime;
  config: AgentServerConfig;
  workspaceRoot: string;
}

/** A runtime over in-memory storage, a scripted provider and a temp workspace. */
export async function createHarness(
  respond: (request: LlmRequest) => Step,
  options: {
    storage?: EphemeralStorage;
    workspaceRoot?: string;
    overrides?: Partial<AgentServerConfig['workers']>;
    subagentGate?: Promise<unknown>;
  } = {}
): Promise<Harness> {
  const storage = options.storage ?? new EphemeralStorage();
  const workspaceRoot = options.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'agent-workers-'));
  const config = testConfig(workspaceRoot, options.overrides);
  const clock = new ManualClock();
  const hub = new RecordingHub();
  const provider = new ScriptedProvider(respond);
  const catalog = new McpCatalog(new NoMcp(), () => [], { now: () => clock.now() });
  const runtime = createAgentRuntime({
    config,
    storage,
    router: new FixedRouter(provider),
    prompts: new FakePrompts(options.subagentGate),
    subagents: [{ name: 'general-purpose', description: 'General work', instructions: 'Do the task.' }],
    hub,
    memory: new NoMemory(),
    calls: createCallSessions(clock),
    titles: new NoTitles(),
    workspace: testWorkspace(config),
    catalog,
    mcp: new NoMcp(),
    memoryTools: [],
    present: false,
    clock,
    logger: silentLogger,
  });
  return { storage, hub, clock, provider, runtime, config, workspaceRoot };
}

/** Creates conversation `id` with the runtime's frozen snapshot. */
export async function seedConversation(harness: Harness, id: string): Promise<void> {
  await harness.storage.conversations.create(
    { id, title: null, titleSource: null },
    {
      systemPrompt: 'MAIN-SYSTEM',
      tools: harness.runtime.tools.definitions() as unknown[],
      templateId: 'system',
      templateHash: 'test',
    }
  );
}

/** Polls until `check` holds (fails after `ms`). */
export async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
