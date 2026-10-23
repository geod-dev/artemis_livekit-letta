import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import { EndCallTool, PresentTool, RunAgentTool, SetCallModeTool } from './agent-tools.ts';
import type { AgentToolContext } from './index.ts';
import type { PresentValidator } from './present-schema.ts';
import type { SubagentSpec, TaskPort } from './task-port.ts';

/** Task port fake: every operation the agent tools call, with the defaults overridable. */
function fakeTasks(overrides: Partial<TaskPort> = {}): TaskPort {
  return {
    adopt: async () => {
      throw new Error('agent tools never adopt commands');
    },
    startSubagent: async () => ({ taskId: 'task-started' }),
    runSubagent: async () => ({ taskId: 'task-run', report: 'Done.', status: 'completed' }),
    list: async () => [],
    get: async () => null,
    stop: async () => false,
    ...overrides,
  } as TaskPort;
}

function fakeCalls(overrides: Partial<Pick<CallSessions, 'setMode' | 'requestEnd'>> = {}) {
  return {
    setMode: () => false,
    requestEnd: () => false,
    ...overrides,
  } as unknown as CallSessions;
}

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    conversationId: 'c1',
    taskId: null,
    turnId: 't1',
    toolCallId: 'call-1',
    signal: new AbortController().signal,
    policy: 'interactive',
    mode: 'text',
    taskDepth: 0,
    tasks: fakeTasks(),
    calls: fakeCalls(),
    ...overrides,
  } as unknown as AgentToolContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

const subagents: SubagentDefinition[] = [{ name: 'researcher', description: 'Looks things up.', instructions: 'Research.' }];

test('run_agent in the main conversation starts a background task and returns its id', async () => {
  const started: SubagentSpec[] = [];
  const tools = context({
    tasks: fakeTasks({
      startSubagent: async (spec) => {
        started.push(spec);
        return { taskId: 'task-7' };
      },
    }),
    turnId: 'turn-9',
    toolCallId: 'call-9',
    taskDepth: 1,
  });

  const tool = new RunAgentTool(subagents);
  const result = await tool.execute(
    { subagent_type: 'researcher', description: 'Find the spec', prompt: 'Read the spec.' },
    tools
  );

  assert.equal(result.isError, false);
  assert.match(textOf(result), /Started background task task-7 \(researcher\)/);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.subagentType, 'researcher');
  assert.equal(started[0]!.originTurnId, 'turn-9');
  assert.equal(started[0]!.originToolCallId, 'call-9');
  assert.equal(started[0]!.depth, 1);
  assert.equal(started[0]!.resumedFromTaskId, null);
});

test('run_agent inside a subagent runs to completion and returns the report', async () => {
  const tool = new RunAgentTool(subagents);
  const result = await tool.execute(
    { subagent_type: 'researcher', description: 'Check', prompt: 'Check it.' },
    context({ policy: 'synchronous', tasks: fakeTasks() })
  );

  assert.equal(result.isError, false);
  assert.equal(textOf(result), 'Done.');
});

test('run_agent reports an error when the nested run did not complete', async () => {
  const tool = new RunAgentTool(subagents);
  const tasks = fakeTasks({
    runSubagent: async () => ({ taskId: 'task-run', report: '', status: 'failed' }),
  });
  const result = await tool.execute(
    { subagent_type: 'researcher', description: 'Check', prompt: 'Check it.' },
    context({ policy: 'synchronous', tasks })
  );

  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'The subagent produced no report.');
});

const validator: PresentValidator = {
  components: ['Text'],
  validateProps: (type) => type === 'Text',
};

test('present accepts a tree whose components pass the validator', async () => {
  const result = await new PresentTool(validator).execute({ componentType: 'Text', text: 'hello' });

  assert.equal(result.isError, false);
  assert.equal(textOf(result), 'Shown to the user in the chat.');
});

test('present rejects a component the validator does not know and lists the allowed ones', async () => {
  const result = await new PresentTool(validator).execute({ componentType: 'Unknown' });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Not shown: A component name or its properties are not supported\./);
  assert.match(textOf(result), /Use only these components: Text\./);
});

test('present rejects a root that is not one component object', async () => {
  const result = await new PresentTool(validator).execute('not a tree' as unknown as Record<string, unknown>);

  assert.equal(result.isError, true);
  assert.match(textOf(result), /The root must be one component object\./);
});

test('set_call_mode fails outside a voice call', async () => {
  const result = await new SetCallModeTool().execute({ mode: 'long' }, context({ calls: fakeCalls({ setMode: () => false }) }));

  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'No voice call is active.');
});

test('set_call_mode sets the mode of the active call', async () => {
  const modes: string[] = [];
  const calls = fakeCalls({
    setMode: (_conversationId, mode) => {
      modes.push(mode);
      return true;
    },
  });
  const result = await new SetCallModeTool().execute({ mode: 'short' }, context({ calls }));

  assert.equal(result.isError, false);
  assert.equal(textOf(result), 'Call mode set to short.');
  assert.deepEqual(modes, ['short']);
});

test('end_call fails outside a voice call', async () => {
  const result = await new EndCallTool().execute({}, context({ calls: fakeCalls({ requestEnd: () => false }) }));

  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'No voice call is active.');
});

test('end_call asks the active call to end after the answer', async () => {
  const ended: string[] = [];
  const calls = fakeCalls({
    requestEnd: (conversationId) => {
      ended.push(conversationId);
      return true;
    },
  });
  const result = await new EndCallTool().execute({}, context({ calls, conversationId: 'c42' }));

  assert.equal(result.isError, false);
  assert.equal(textOf(result), 'The call ends after this answer.');
  assert.deepEqual(ended, ['c42']);
});
