import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type LlmRequest, LlmError, LlmProvider, type LlmStreamEvent, type ModelInfo, ProviderRegistry } from '@artemis/llm';
import { EphemeralStorage } from '@artemis/storage/testing';
import { loadConfig } from '../config.ts';
import { ConversationEventHub } from '../events/hub.ts';
import { createModelRouter } from '../models/routing.ts';
import { PromptRenderer } from '../prompts/renderer.ts';
import { createTitleService } from './title-service.ts';

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

/** Replies with `reply` (or fails with `failure`) once `gate` opens, when one is given; records every request. */
class TitleProvider extends LlmProvider {
  readonly id = 'anthropic';
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly reply: string,
    private readonly failure?: Error,
    private readonly gate?: Promise<void>
  ) {
    super();
  }

  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    if (this.gate) await this.gate;
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
    const storage = new EphemeralStorage();
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', OPENAI_COMPATIBLE_BASE_URL: 'http://llm.test/v1', OPENAI_COMPATIBLE_API_KEY: 'test-key' });
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

  /** The stored title after one request whose model replies with `reply`. */
  async function titleFromReply(reply: string, firstUserText = 'hello there'): Promise<string | null | undefined> {
    const { storage, service } = await setup(new TitleProvider(reply));
    await service.request('conv_t', firstUserText);
    return (await storage.conversations.get('conv_t'))?.title;
  }

  it('names an untitled conversation from the first message, without feeding the main conversation', async () => {
    const provider = new TitleProvider('Phone Wars 2024');
    const { storage, service, updates } = await setup(provider);
    await service.request('conv_t', 'what is the best budget phone right now?');

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

  const cleanedReplies: Array<[string, string]> = [
    ['Title: "Phone Wars 2024."', 'Phone Wars 2024'],
    ['<think>plan</think>\n**Python Import Panic**', 'Python Import Panic'],
    ['\n\n  Quitter le Bureau  \nsecond line', 'Quitter le Bureau'],
  ];
  for (const [reply, title] of cleanedReplies) {
    it(`keeps the one short line of ${JSON.stringify(reply)} as the title`, async () => {
      assert.equal(await titleFromReply(reply), title);
    });
  }

  it('falls back to the first message when the reply holds no usable title', async () => {
    assert.equal(await titleFromReply('   ', 'my first message'), 'my first message');
    assert.equal(await titleFromReply('<think>only thoughts</think>', 'my first message'), 'my first message');
  });

  it('truncates long titles to 60 characters with an ellipsis', async () => {
    const title = await titleFromReply('a'.repeat(100));
    assert.equal(title?.length, 60);
    assert.ok(title?.endsWith('…'));
  });

  it('keeps a user title when the conversation was renamed meanwhile', async () => {
    const provider = new TitleProvider('Generated');
    const { storage, service, updates } = await setup(provider);
    await storage.conversations.rename('conv_t', 'Mine', 'user');
    await service.request('conv_t', 'hello there');

    const record = await storage.conversations.get('conv_t');
    assert.equal(record?.title, 'Mine');
    assert.deepEqual(updates, []);
  });

  it('falls back to the first message when the title model fails, at most 60 characters', async () => {
    const { storage, service } = await setup(new TitleProvider('', new LlmError('unknown', 'boom', false)));
    await service.request('conv_t', '  fix my python   import error  ');
    assert.equal((await storage.conversations.get('conv_t'))?.title, 'fix my python import error');

    const long = await setup(new TitleProvider('', new LlmError('unknown', 'boom', false)));
    await long.service.request('conv_t', 'x'.repeat(200));
    assert.equal((await long.storage.conversations.get('conv_t'))?.title?.length, 60);
  });

  it('runs at most one request per conversation at a time', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const provider = new TitleProvider('Once', undefined, gate);
    const { service } = await setup(provider);
    const first = service.request('conv_t', 'first');
    const second = service.request('conv_t', 'second');
    open();
    await Promise.all([first, second]);
    assert.equal(provider.requests.length, 1);
  });

  it('ignores requests after stop', async () => {
    const provider = new TitleProvider('Late');
    const { service } = await setup(provider);
    await service.stop();
    await service.request('conv_t', 'hello');
    assert.equal(provider.requests.length, 0);
  });
});
