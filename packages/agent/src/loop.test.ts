import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError, type LlmMessage, type LlmStreamEvent } from '@artemis/llm';
import { errorResult, textResult, type ToolContext } from '@artemis/tools';
import { AgentLoop, type LoopEvent } from './loop.ts';
import {
  collect,
  FakeProvider,
  FakeToolset,
  loopInput,
  messageEvents,
  response,
  textStep,
  toolStep,
} from './test-support.ts';

function types(events: LoopEvent[]): string[] {
  return events.map((event) => event.type);
}

function outcomeOf(events: LoopEvent[]) {
  const last = events.at(-1);
  assert.equal(last?.type, 'loop_end', 'loop_end must be the last event');
  return last.outcome;
}

function toolResultMessages(messages: LlmMessage[]) {
  return messages.filter((message) => message.role === 'user' && message.content.some((c) => c.type === 'tool_result'));
}

describe('AgentLoop', () => {
  it('streams text deltas and completes in one step', async () => {
    const provider = new FakeProvider([textStep('Hello there')]);
    const toolset = new FakeToolset({});
    const events = await collect(new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal })));

    assert.deepEqual(types(events), ['step_start', 'text_delta', 'assistant_message', 'loop_end']);
    const delta = events[1];
    assert.deepEqual(delta, { type: 'text_delta', messageId: 'msg_1', blockIndex: 0, text: 'Hello there' });
    const outcome = outcomeOf(events);
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, 'Hello there');
    assert.equal(outcome.model, 'fake-model');
    assert.deepEqual(outcome.usage, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      steps: 1,
      lastContextTokens: 10,
    });
    assert.equal(provider.requests[0]?.system, 'system prompt');
    assert.equal(provider.requests[0]?.parallelToolCalls, true);
    assert.deepEqual(provider.requests[0]?.tools, toolset.definitions());
  });

  it('forwards reasoning deltas with the step message id', async () => {
    const provider = new FakeProvider([
      [
        { type: 'message_start', model: 'fake-model' },
        { type: 'reasoning_delta', index: 0, text: 'thinking' },
        { type: 'message_end', message: response([{ type: 'text', text: 'ok' }], 'end_turn') },
      ],
    ]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset: new FakeToolset({}), signal: new AbortController().signal }))
    );
    assert.deepEqual(events[1], { type: 'reasoning_delta', messageId: 'msg_1', blockIndex: 0, text: 'thinking' });
  });

  it('runs a tool call, persists the assistant message before executing, and continues', async () => {
    const provider = new FakeProvider([toolStep([{ id: 't1', name: 'read', input: { path: 'a.txt' } }], 'Checking'), textStep('done')]);
    const toolset = new FakeToolset({
      read: (input) => textResult(`contents of ${(input as { path: string }).path}`),
    });
    const events = await collect(new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal })));

    assert.deepEqual(types(events), [
      'step_start',
      'text_delta',
      'tool_call',
      'assistant_message',
      'tool_result',
      'tool_results_message',
      'step_start',
      'text_delta',
      'assistant_message',
      'loop_end',
    ]);
    const toolCall = events[2];
    assert.deepEqual(toolCall, { type: 'tool_call', messageId: 'msg_1', toolCallId: 't1', name: 'read' });
    const toolDone = events[4];
    assert.equal(toolDone?.type, 'tool_result');
    assert.equal(toolDone.toolCallId, 't1');
    assert.equal(toolDone.name, 'read');
    assert.deepEqual(toolDone.input, { path: 'a.txt' });
    assert.equal(toolDone.result.isError, false);

    const results = events[5];
    assert.equal(results?.type, 'tool_results_message');
    assert.equal(results.messageId, 'msg_2');

    const outcome = outcomeOf(events);
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, 'done');
    assert.equal(outcome.usage.steps, 2);
    assert.equal(outcome.usage.inputTokens, 20);

    // Second request replays the assistant tool_use and the tool result verbatim.
    const second = provider.requests[1]?.messages ?? [];
    assert.equal(second.length, 3);
    assert.equal(second[1]?.role, 'assistant');
    assert.deepEqual(second[2], {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'contents of a.txt' }], isError: false }],
    });
  });

  it('runs the calls of one step concurrently and returns results in call order', { timeout: 2000 }, async () => {
    // `slow` only finishes once the consumer has seen `fast` complete. Sequential
    // execution would start `slow` first and never reach `fast`, hitting the timeout.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const toolset = new FakeToolset({
      slow: async () => {
        await gate;
        return textResult('slow result');
      },
      fast: () => textResult('fast result'),
    });
    const provider = new FakeProvider([toolStep([{ id: 'a', name: 'slow' }, { id: 'b', name: 'fast' }]), textStep('end')]);

    const events: LoopEvent[] = [];
    const loop = new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal }));
    for await (const event of loop) {
      events.push(event);
      if (event.type === 'tool_result' && event.toolCallId === 'b') release();
    }

    const completions = events.flatMap((event) => (event.type === 'tool_result' ? [event.toolCallId] : []));
    assert.deepEqual(completions, ['b', 'a'], 'tool_result events arrive in completion order');

    const resultMessage = events.find((event) => event.type === 'tool_results_message');
    assert.equal(resultMessage?.type, 'tool_results_message');
    assert.deepEqual(
      resultMessage.message.content.map((block) => block.type === 'tool_result' && block.toolUseId),
      ['a', 'b'],
      'the user message keeps call order'
    );
    assert.equal(outcomeOf(events).status, 'completed');
  });

  it('turns tool throws and unknown tools into error results and keeps going', async () => {
    const toolset = new FakeToolset({
      boom: () => {
        throw new Error('disk on fire');
      },
    });
    const provider = new FakeProvider([
      toolStep([{ id: 't1', name: 'boom' }, { id: 't2', name: 'missing' }]),
      textStep('recovered'),
    ]);
    const events = await collect(new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal })));

    const byId = Object.fromEntries(
      events.flatMap((event) => (event.type === 'tool_result' ? [[event.toolCallId, event.result] as const] : []))
    );
    assert.equal(byId.t1?.isError, true);
    assert.equal(byId.t1?.content[0]?.type === 'text' && byId.t1.content[0].text, 'disk on fire');
    assert.equal(byId.t2?.isError, true);
    assert.equal(outcomeOf(events).status, 'completed');
    assert.equal(outcomeOf(events).text, 'recovered');
  });

  it('stops at maxSteps without running the tools of the last step', async () => {
    const toolset = new FakeToolset({ loop: () => textResult('again') });
    const provider = new FakeProvider([
      toolStep([{ id: 't1', name: 'loop' }]),
      toolStep([{ id: 't2', name: 'loop' }]),
      toolStep([{ id: 't3', name: 'loop' }]),
    ]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal, maxSteps: 2 }))
    );

    const outcome = outcomeOf(events);
    assert.equal(outcome.status, 'max_steps');
    assert.equal(outcome.usage.steps, 2);
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(toolset.executed, ['loop'], 'the second step tool call must not run');

    const last = events.filter((event) => event.type === 'tool_result').at(-1);
    assert.equal(last?.type === 'tool_result' && last.result.isError, true);
    // Stored history stays valid: every tool_use has a result.
    const history = toolResultMessages(provider.requests[1]?.messages ?? []);
    assert.equal(history.length, 1);
  });

  it('cancels mid-stream: keeps the partial message and runs no tools', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([
      async function* (_request, signal): AsyncGenerator<LlmStreamEvent> {
        yield { type: 'message_start', model: 'fake-model' };
        yield { type: 'block_start', index: 0, block: 'text' };
        yield { type: 'text_delta', index: 0, text: 'Hel' };
        if (signal.aborted) {
          yield { type: 'message_end', message: response([{ type: 'text', text: 'Hel' }], 'aborted') };
        }
      },
    ]);
    const toolset = new FakeToolset({ bash: () => textResult('never') });
    const events: LoopEvent[] = [];
    for await (const event of new AgentLoop().run(loopInput({ provider, toolset, signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'text_delta') controller.abort();
    }

    assert.deepEqual(types(events), ['step_start', 'text_delta', 'assistant_message', 'loop_end']);
    const assistant = events[2];
    assert.equal(assistant?.type === 'assistant_message' && assistant.response.stopReason, 'aborted');
    assert.equal(assistant?.type === 'assistant_message' && assistant.message.content[0]?.type === 'text' && assistant.message.content[0].text, 'Hel');
    assert.equal(outcomeOf(events).status, 'cancelled');
    assert.equal(outcomeOf(events).text, 'Hel');
    assert.deepEqual(toolset.executed, []);
  });

  it('cancels mid-tool: a stuck tool gets a synthetic "Cancelled by the user" result', async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const toolset = new FakeToolset({
      stuck: (_input, context: ToolContext) => {
        seenSignals.push(context.signal);
        // Ignores the signal and never settles: the loop must still finish.
        setImmediate(() => controller.abort());
        return new Promise<never>(() => undefined);
      },
    });
    const provider = new FakeProvider([toolStep([{ id: 't1', name: 'stuck' }, { id: 't2', name: 'stuck' }], 'Working')]);

    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset, signal: controller.signal }))
    );

    assert.equal(outcomeOf(events).status, 'cancelled');
    assert.ok(seenSignals.every((signal) => signal === controller.signal), 'tools receive the loop signal');
    const results = events.flatMap((event) => (event.type === 'tool_result' ? [event.result] : []));
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, [{ type: 'text', text: 'Cancelled by the user' }]);
    }
    const message = events.find((event) => event.type === 'tool_results_message');
    assert.equal(message?.type === 'tool_results_message' && message.message.content.length, 2);
  });

  it('an abort fired inside a tool supersedes the value it returns', async () => {
    const controller = new AbortController();
    const toolset = new FakeToolset({
      quick: () => {
        controller.abort();
        return textResult('returned anyway');
      },
    });
    const provider = new FakeProvider([toolStep([{ id: 't1', name: 'quick' }])]);
    const events = await collect(new AgentLoop().run(loopInput({ provider, toolset, signal: controller.signal })));
    const result = events.find((event) => event.type === 'tool_result');
    assert.equal(result?.type === 'tool_result' && result.result.isError, true);
    assert.equal(outcomeOf(events).status, 'cancelled');
  });

  it('does nothing when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider([textStep('unused')]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset: new FakeToolset({}), signal: controller.signal }))
    );
    assert.deepEqual(types(events), ['loop_end']);
    assert.equal(outcomeOf(events).status, 'cancelled');
    assert.equal(provider.requests.length, 0);
  });

  it('does not run tools on a refusal and answers their tool_use with error results', async () => {
    const provider = new FakeProvider([
      messageEvents([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }], 'refusal'),
    ]);
    const toolset = new FakeToolset({ bash: () => textResult('never') });
    const events = await collect(new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal })));

    const outcome = outcomeOf(events);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'The model refused the request');
    assert.deepEqual(toolset.executed, []);
    const result = events.find((event) => event.type === 'tool_result');
    assert.equal(result?.type === 'tool_result' && result.result.isError, true);
  });

  it('ends on max_tokens without tools', async () => {
    const provider = new FakeProvider([messageEvents([{ type: 'text', text: 'cut' }], 'max_tokens')]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset: new FakeToolset({}), signal: new AbortController().signal }))
    );
    const outcome = outcomeOf(events);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'The response reached the max_tokens limit');
    assert.equal(outcome.text, 'cut');
  });

  it('continues after pause_turn with the same history', async () => {
    const provider = new FakeProvider([
      messageEvents([{ type: 'text', text: 'searching' }], 'pause_turn'),
      textStep('final answer'),
    ]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset: new FakeToolset({}), signal: new AbortController().signal }))
    );
    assert.equal(outcomeOf(events).status, 'completed');
    assert.equal(outcomeOf(events).text, 'final answer');
    assert.equal(provider.requests[1]?.messages.at(-1)?.role, 'assistant');
  });

  it('reports a provider error as a failed outcome', async () => {
    const provider = new FakeProvider([
      () => {
        throw new LlmError('overloaded', 'Provider busy', true);
      },
    ]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset: new FakeToolset({}), signal: new AbortController().signal }))
    );
    assert.deepEqual(types(events), ['step_start', 'loop_end']);
    assert.equal(outcomeOf(events).status, 'failed');
    assert.equal(outcomeOf(events).error, 'Provider busy');
  });

  it('fails when the provider ends without a message', async () => {
    const provider = new FakeProvider([[{ type: 'message_start', model: 'fake-model' }]]);
    const events = await collect(
      new AgentLoop().run(loopInput({ provider, toolset: new FakeToolset({}), signal: new AbortController().signal }))
    );
    assert.equal(outcomeOf(events).status, 'failed');
    assert.equal(outcomeOf(events).error, 'The provider ended without a message');
  });

  it('keeps the error result text of a tool that returns isError', async () => {
    const toolset = new FakeToolset({ edit: () => errorResult('no match') });
    const provider = new FakeProvider([toolStep([{ id: 't1', name: 'edit' }]), textStep('ok')]);
    const events = await collect(new AgentLoop().run(loopInput({ provider, toolset, signal: new AbortController().signal })));
    const message = events.find((event) => event.type === 'tool_results_message');
    assert.equal(message?.type === 'tool_results_message' && message.message.content[0]?.type === 'tool_result' && message.message.content[0].isError, true);
  });
});
