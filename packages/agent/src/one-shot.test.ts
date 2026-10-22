import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '@artemis/core';
import type { LlmStreamEvent } from '@artemis/llm';
import { oneShot } from './one-shot.ts';
import { fakeRoute, FakeProvider, messageEvents, response, textStep } from './test-support.ts';

describe('oneShot', () => {
  it('sends system and prompt without tools and returns the text', async () => {
    const provider = new FakeProvider([textStep('Fix the login bug')]);
    const title = await oneShot({
      route: fakeRoute(provider, { thinking: 'disabled', effort: 'low', maxTokens: 64 }),
      system: 'title system',
      prompt: 'user says: login is broken',
    });

    assert.equal(title, 'Fix the login bug');
    const [request] = provider.requests;
    assert.equal(request?.system, 'title system');
    assert.equal(request?.model, 'fake-model');
    assert.equal(request?.thinking, 'disabled');
    assert.equal(request?.effort, 'low');
    assert.equal(request?.maxTokens, 64);
    assert.deepEqual(request?.tools, []);
    assert.deepEqual(request?.messages, [{ role: 'user', content: [{ type: 'text', text: 'user says: login is broken' }] }]);
  });

  it('joins text blocks and ignores reasoning', async () => {
    const provider = new FakeProvider([
      [
        { type: 'message_start', model: 'fake-model' },
        {
          type: 'message_end',
          message: response(
            [
              { type: 'reasoning', text: 'hmm' },
              { type: 'text', text: 'Part one. ' },
              { type: 'text', text: 'Part two.' },
            ],
            'end_turn'
          ),
        },
      ],
    ]);
    const text = await oneShot({ route: fakeRoute(provider), system: 's', prompt: 'p' });
    assert.equal(text, 'Part one. Part two.');
  });

  it('rejects on refusal with an LlmError', async () => {
    const provider = new FakeProvider([messageEvents([], 'refusal')]);
    await assert.rejects(oneShot({ route: fakeRoute(provider), system: 's', prompt: 'p' }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal((error as AppError).code, 'refusal');
      return true;
    });
  });

  it('rejects when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller gave up'));
    const provider = new FakeProvider([textStep('ignored')]);
    await assert.rejects(
      oneShot({ route: fakeRoute(provider), system: 's', prompt: 'p', signal: controller.signal }),
      /caller gave up/
    );
  });

  it('rejects when the timeout fires before the model answers', async () => {
    const provider = new FakeProvider([
      async function* (_request, signal): AsyncGenerator<LlmStreamEvent> {
        yield { type: 'message_start', model: 'fake-model' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'message_end', message: response([], 'aborted') };
      },
    ]);
    await assert.rejects(oneShot({ route: fakeRoute(provider), system: 's', prompt: 'p', timeoutMs: 20 }));
  });
});
