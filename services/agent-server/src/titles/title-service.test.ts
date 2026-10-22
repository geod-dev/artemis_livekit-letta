import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type LlmRequest, LlmError, LlmProvider, type LlmStreamEvent, type ModelInfo, ProviderRegistry } from '@artemis/llm';
import { InMemoryStorage } from '@artemis/storage';
import { loadConfig } from '../config.ts';
import { ConversationEventHub } from '../events/hub.ts';
import { createModelRouter } from '../models/routing.ts';
import { PromptRenderer } from '../prompts/renderer.ts';
import { cleanTitle, createTitleService, fallbackTitle, type TitleService } from './title-service.ts';

/** The task model's provider: the title tests never route a worker turn through it. */
class IdleProvider extends LlmProvider {
  readonly id = 'openai-compatible';

  async *stream(_request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    throw new Error('not used by title tests');
  }

  modelInfo(model: string): ModelInfo {
    return { model, contextWindow: 128_000, maxOutputTokens: 8_000, supportsThinking: true, supportsImages: false };
  }
}

/** Replies with `reply` (or fails with `failure`); records every request. */
class TitleProvider extends LlmProvider {
  readonly id = 'anthropic';
  readonly requests: LlmRequest[] = [];

  constructor(private readonly reply: string, private readonly failure?: Error, private readonly delayMs = 0) {
    super();
  }

  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (signal?.aborted) throw new Error('aborted');
    yield {
      type: 'message_end',
      message: {
        model: request.model,
        content: [{ type: 'text', text: this.reply }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        timings: { startedAt: new Date().toISOString(), durationMs: 1 },
      },
    };
  }

  modelInfo(model: string): ModelInfo {
    return { model, contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, supportsImages: true };
  }
}

describe('cleanTitle', () => {
  it('keeps one short line without quotes, markup, labels or trailing punctuation', () => {
    assert.equal(cleanTitle('Title: "Phone Wars 2024."'), 'Phone Wars 2024');
    assert.equal(cleanTitle('<think>plan</think>\n**Python Import Panic**'), 'Python Import Panic');
    assert.equal(cleanTitle('\n\n  Quitter le Bureau  \nsecond line'), 'Quitter le Bureau');
  });

  it('returns null when nothing usable is left', () => {
    assert.equal(cleanTitle('   '), null);
    assert.equal(cleanTitle('<think>only thoughts</think>'), null);
  });

  it('truncates long titles to 60 characters with an ellipsis', () => {
    const title = cleanTitle('a'.repeat(100));
    assert.equal(title?.length, 60);
    assert.ok(title?.endsWith('…'));
  });
});

describe('fallbackTitle', () => {
  it('uses the first 60 characters with collapsed whitespace', () => {
    assert.equal(fallbackTitle('  fix   my\n\nimport  '), 'fix my import');
    assert.equal(fallbackTitle('x'.repeat(200)).length, 60);
    assert.equal(fallbackTitle('   '), 'New chat');
  });
});

describe('TitleService', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'titles-'));
    await writeFile(join(dir, 'title.md'), 'Name the chat.');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(provider: TitleProvider) {
    const storage = new InMemoryStorage();
    const config = loadConfig({ DATABASE_URL: 'postgresql://x' });
    const router = createModelRouter(config, new ProviderRegistry([provider, new IdleProvider()]));
    const events = new ConversationEventHub();
    const service = createTitleService({ storage, router, prompts: new PromptRenderer(dir), events });
    const conversation = await storage.conversations.create({ id: 'conv_t', title: null, titleSource: null }, {
      systemPrompt: 'system',
      tools: [],
      templateId: 'system',
      templateHash: 'h',
    });
    const updates: unknown[] = [];
    events.subscribe(conversation.id, (event) => {
      if (event.type === 'conversation_updated') updates.push(event.conversation);
    });
    return { storage, service, updates };
  }

  async function waitForSettled(service: TitleService) {
    await service.idle();
  }

  it('names an untitled conversation from the first message, without feeding the main conversation', async () => {
    const provider = new TitleProvider('Phone Wars 2024');
    const { storage, service, updates } = await setup(provider);
    service.request('conv_t', 'what is the best budget phone right now?');
    await waitForSettled(service);

    const record = await storage.conversations.get('conv_t');
    assert.equal(record?.title, 'Phone Wars 2024');
    assert.equal(record?.titleSource, 'auto');
    assert.deepEqual(updates, [{ id: 'conv_t', title: 'Phone Wars 2024', updatedAt: record?.updatedAt }]);

    const [request] = provider.requests;
    assert.equal(request?.system, 'Name the chat.');
    assert.deepEqual(request?.tools, []);
    assert.equal(request?.maxTokens, 64);
    assert.equal(request?.thinking, 'disabled');
    assert.deepEqual(request?.messages, [
      { role: 'user', content: [{ type: 'text', text: 'what is the best budget phone right now?' }] },
    ]);
  });

  it('keeps a user title when the conversation was renamed meanwhile', async () => {
    const provider = new TitleProvider('Generated');
    const { storage, service, updates } = await setup(provider);
    await storage.conversations.rename('conv_t', 'Mine', 'user');
    service.request('conv_t', 'hello there');
    await waitForSettled(service);

    const record = await storage.conversations.get('conv_t');
    assert.equal(record?.title, 'Mine');
    assert.deepEqual(updates, []);
  });

  it('falls back to the first message when the title model fails', async () => {
    const provider = new TitleProvider('', new LlmError('unknown', 'boom', false));
    const { storage, service } = await setup(provider);
    service.request('conv_t', '  fix my python   import error  ');
    await waitForSettled(service);
    assert.equal((await storage.conversations.get('conv_t'))?.title, 'fix my python import error');
  });

  it('runs at most one request per conversation at a time', async () => {
    const provider = new TitleProvider('Once', undefined, 20);
    const { service } = await setup(provider);
    service.request('conv_t', 'first');
    service.request('conv_t', 'second');
    await waitForSettled(service);
    assert.equal(provider.requests.length, 1);
  });

  it('ignores requests after stop', async () => {
    const provider = new TitleProvider('Late');
    const { service } = await setup(provider);
    await service.stop();
    service.request('conv_t', 'hello');
    await waitForSettled(service);
    assert.equal(provider.requests.length, 0);
  });
});
