import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ConversationTask } from '@shared/chat-types';
import { filterTaskKinds, groupAgentRuns, runDuration, taskRuns } from './agent-runs.ts';

const launch = (
  id: string,
  agent: string,
  title: string,
  prompt: string,
  resumed = false
): ChatMessage => ({
  id: `call-${id}`,
  role: 'tool',
  toolCallId: `call-${id}`,
  name: 'Agent',
  args: JSON.stringify({
    description: title,
    prompt,
    ...(resumed ? { agent_id: agent, conversation_id: 'default' } : {}),
  }),
  result: `Task running in background with task ID: ${id}\nAgent ID: ${agent}\nConversation ID: default`,
});
const result = (id: string, durationMs: number, report: string): ChatMessage => ({
  id: `event-${id}`,
  role: 'event',
  kind: 'task_result',
  taskId: id,
  text: id,
  status: 'completed',
  durationMs,
  detail: report,
});

test('two agents with default conversations stay distinct while reruns retain names, prompts and per-run timing', () => {
  const messages = [
    launch('7', 'agent-a', '🔢 Product', 'Compute product'),
    launch('8', 'agent-b', '🔢 Power', 'Compute power'),
    result('7', 11082, 'Product answer'),
    result('8', 14248, 'Power answer'),
    launch('9', 'agent-a', '🔢 Explain product', 'How did you compute it?', true),
    launch('10', 'agent-b', '🔢 Explain power', 'Which tool did you use?', true),
    result('9', 3844, 'Python'),
    result('10', 4060, 'Also Python'),
  ];
  const inventory: ConversationTask[] = ['10', '9', '8', '7'].map((id) => ({
    id,
    title: 'Native name',
    status: 'completed',
  }));
  const runs = taskRuns(inventory, messages);
  assert.deepEqual(
    runs.map((run) => run.durationMs),
    [11082, 14248, 3844, 4060]
  );
  assert.deepEqual(
    runs.map((run) => run.agentTitle),
    ['🔢 Product', '🔢 Power', '🔢 Product', '🔢 Power']
  );
  const agents = groupAgentRuns(runs);
  assert.equal(agents.length, 2);
  assert.deepEqual(
    agents.map((agent) => agent.durationMs),
    [14926, 18308]
  );
  assert.deepEqual(
    agents.map((agent) => agent.runs.length),
    [2, 2]
  );
  assert.deepEqual(
    agents[1].runs.map((run) => [run.title, run.prompt, run.report]),
    [
      ['🔢 Power', 'Compute power', 'Power answer'],
      ['🔢 Explain power', 'Which tool did you use?', 'Also Python'],
    ]
  );
});

test('live reruns keep one agent row and a completion event supersedes a stale running inventory', () => {
  const messages = [
    launch('1', 'a', 'Original', 'first'),
    result('1', 2000, 'Done'),
    launch('2', 'a', 'Follow-up', 'second', true),
  ];
  const inventory: ConversationTask[] = [{ id: '2', title: 'Follow-up', status: 'running' }];
  let agents = groupAgentRuns(taskRuns(inventory, messages));
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'running');
  assert.equal(agents[0].title, 'Original');
  assert.equal(agents[0].durationMs, 2000);
  agents = groupAgentRuns(taskRuns(inventory, [...messages, result('2', 500, 'Again')]));
  assert.equal(agents[0].status, 'completed');
  assert.equal(agents[0].durationMs, 2500);
});

test('gateway events match by update identity and commands stay distinct tasks', () => {
  const runs = taskRuns(
    [{ id: 'x', title: 'Worker', status: 'completed', updateId: 'u' }],
    [
      launch('x', 'a', 'Worker', 'Prompt'),
      {
        id: 'e',
        role: 'event',
        kind: 'task_result',
        updateId: 'u',
        text: 'Done',
        durationMs: 4060,
        detail: 'Response',
      },
    ]
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].durationMs, 4060);
  const commands = groupAgentRuns(
    taskRuns(
      [
        { id: 'cmd1', title: 'Same title', kind: 'command', status: 'completed' },
        { id: 'cmd2', title: 'Same title', kind: 'command', status: 'completed' },
      ],
      []
    )
  );
  assert.equal(commands.length, 2);
  assert.equal(commands[0].kind, 'command');
  assert.equal(commands[0].durationMs, undefined);
  assert.deepEqual(taskRuns([], [result('bash_1', 100, 'Command output')]), []);
  assert.deepEqual(taskRuns([{ id: 'legacy', title: 'Unknown work', status: 'running' }], []), []);
});

test('task type tags show all by default and combine agent and command selections', () => {
  const tasks: ConversationTask[] = [
    { id: 'worker', title: 'Worker', kind: 'agent', status: 'running' },
    { id: 'bash_1', title: 'Command', kind: 'command', status: 'completed' },
  ];
  assert.deepEqual(filterTaskKinds(tasks, []), tasks);
  assert.deepEqual(filterTaskKinds(tasks, ['agent']), [tasks[0]]);
  assert.deepEqual(filterTaskKinds(tasks, ['command']), [tasks[1]]);
  assert.deepEqual(filterTaskKinds(tasks, ['agent', 'command']), tasks);
});

test('persisted assignments remain available when the launch arguments are missing', () => {
  const inventory: ConversationTask[] = [
    { id: 'x', title: 'Worker', kind: 'agent', status: 'completed', prompt: 'Original assignment' },
  ];
  const message = launch('x', 'a', 'Worker', 'unused');
  if (message.role === 'tool') message.args = undefined;
  assert.equal(taskRuns(inventory, [message])[0].prompt, 'Original assignment');
  assert.equal(taskRuns(inventory, [])[0].prompt, 'Original assignment');
});

test('background commands retain their command, output and tool identity without becoming agents', () => {
  const runs = taskRuns(
    [],
    [
      {
        id: 'bash-call',
        role: 'tool',
        toolCallId: 'bash-call',
        name: 'Bash',
        args: JSON.stringify({ command: 'sleep 5; date', description: 'Read time' }),
        result: 'Command is still running with task ID: bash_1\nOutput file: /tmp/bash_1.log',
      },
      result('bash_1', 5000, 'Current time'),
    ]
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'command');
  assert.equal(runs[0].prompt, 'sleep 5; date');
  assert.equal(runs[0].report, 'Current time');
  assert.equal(runs[0].toolCallId, 'bash-call');
  assert.equal(runs[0].status, 'completed');
  assert.deepEqual(filterTaskKinds(runs, ['agent']), []);
});

test('live run durations advance independently while recorded completed durations stay fixed', () => {
  const start = Date.parse('2026-10-15T14:00:00Z');
  const running = {
    id: 'live',
    title: 'Follow-up',
    status: 'running' as const,
    startedAt: new Date(start).toISOString(),
  };
  assert.equal(runDuration(running, start + 2000), 2000);
  assert.equal(runDuration(running, start + 3000), 3000);
  assert.equal(runDuration(running, start - 1000), 0);
  assert.equal(
    runDuration({ ...running, status: 'completed', durationMs: 3844 }, start + 60000),
    3844
  );
  const runs = taskRuns(
    [],
    [
      launch('1', 'a', 'Name', 'Original'),
      result('1', 11082, 'Done'),
      launch('2', 'a', 'Follow-up', 'Again', true),
    ]
  );
  assert.equal(runs[0].rerunName, undefined);
  assert.equal(runs[1].rerunName, 'Follow-up');
  const total = groupAgentRuns(
    runs.map((run) =>
      run.id === '2' ? { ...run, durationMs: runDuration(running, start + 3000) } : run
    )
  );
  assert.equal(total[0].durationMs, 14082);
});
