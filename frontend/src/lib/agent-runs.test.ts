import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ConversationTask } from '@shared/chat-types';
import {
  commandOutput,
  filterTaskKinds,
  groupAgentRuns,
  runDuration,
  stripLeadingEmoji,
  taskRuns,
} from './agent-runs.ts';

const agent = (
  id: string,
  title: string,
  startedAt: string,
  extra: Partial<ConversationTask> = {}
): ConversationTask => ({
  id,
  title,
  kind: 'agent',
  status: 'completed',
  toolCallId: `call-${id}`,
  startedAt,
  ...extra,
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

test('two agents stay distinct while follow-ups keep their agent name and per-run timing', () => {
  const tasks: ConversationTask[] = [
    agent('7', '🔢 Product', '2026-10-20T10:00:00Z', {
      prompt: 'Compute product',
      durationMs: 11082,
      report: 'Product answer',
    }),
    agent('8', '🔢 Power', '2026-10-20T10:00:01Z', {
      prompt: 'Compute power',
      durationMs: 14248,
      report: 'Power answer',
    }),
    agent('9', '🔢 Explain product', '2026-10-20T10:05:00Z', {
      prompt: 'How did you compute it?',
      resumedFromTaskId: '7',
      durationMs: 3844,
      report: 'Python',
    }),
    agent('10', '🔢 Explain power', '2026-10-20T10:06:00Z', {
      prompt: 'Which tool did you use?',
      resumedFromTaskId: '8',
      durationMs: 4060,
      report: 'Also Python',
    }),
  ];
  const runs = taskRuns(tasks, []);
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
    agents.map((group) => group.durationMs),
    [14926, 18308]
  );
  assert.deepEqual(
    agents.map((group) => group.runs.length),
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

test('a follow-up of a running task keeps one agent row, and its completion event settles it', () => {
  const first = agent('1', 'Original', '2026-10-20T10:00:00Z', {
    status: 'completed',
    durationMs: 2000,
  });
  const follow = agent('2', 'Follow-up', '2026-10-20T10:01:00Z', {
    status: 'running',
    resumedFromTaskId: '1',
  });
  let agents = groupAgentRuns(taskRuns([first, follow], [result('1', 2000, 'Done')]));
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'running');
  assert.equal(agents[0].title, 'Original');
  assert.equal(agents[0].durationMs, 2000);
  agents = groupAgentRuns(
    taskRuns([first, { ...follow, status: 'completed' }], [result('2', 500, 'Again')])
  );
  assert.equal(agents[0].status, 'completed');
  assert.equal(agents[0].durationMs, 2500);
});

test('an update event refreshes the task it names by update identity', () => {
  const runs = taskRuns(
    [agent('x', 'Worker', '2026-10-20T10:00:00Z', { updateId: 'u' })],
    [
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
  assert.equal(runs[0].report, 'Response');
});

test('commands stay distinct tasks, outside any agent group', () => {
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
});

test('tasks without a known kind are not runs', () => {
  assert.deepEqual(taskRuns([{ id: 'legacy', title: 'Unknown work', status: 'running' }], []), []);
});

test('runs are ordered by when they started', () => {
  const runs = taskRuns(
    [
      agent('late', 'Late', '2026-10-20T11:00:00Z'),
      agent('early', 'Early', '2026-10-20T09:00:00Z'),
    ],
    []
  );
  assert.deepEqual(
    runs.map((run) => run.id),
    ['early', 'late']
  );
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

test('the recorded prompt of a worker is kept', () => {
  const runs = taskRuns(
    [agent('x', 'Worker', '2026-10-20T10:00:00Z', { prompt: 'Original assignment' })],
    []
  );
  assert.equal(runs[0].prompt, 'Original assignment');
});

test('a background command keeps its command, output and tool call', () => {
  const runs = taskRuns(
    [
      {
        id: 'bash_1',
        title: 'Read time',
        kind: 'command',
        status: 'completed',
        command: 'sleep 5; date',
        stdout: 'Current time',
        exitCode: 0,
        toolCallId: 'bash-call',
      },
    ],
    []
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].toolCallId, 'bash-call');
  assert.deepEqual(commandOutput(runs[0]), {
    command: 'sleep 5; date',
    output: 'Current time',
    exitCode: 0,
  });
  assert.deepEqual(filterTaskKinds(runs, ['agent']), []);
});

test('command output falls back to the report and keeps stdout before stderr', () => {
  assert.deepEqual(commandOutput({ report: 'only report', prompt: 'ls' }), {
    command: 'ls',
    output: 'only report',
    exitCode: undefined,
  });
  assert.equal(commandOutput({ stdout: 'out', stderr: 'err', command: 'x' }).output, 'out\nerr');
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
    [
      agent('1', 'Name', '2026-10-15T13:00:00Z', { prompt: 'Original', durationMs: 11082 }),
      agent('2', 'Follow-up', '2026-10-15T13:30:00Z', {
        resumedFromTaskId: '1',
        status: 'running',
      }),
    ],
    []
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

test('emoji are stripped from the start of rerun labels', () => {
  assert.equal(stripLeadingEmoji('🔢 Explain power'), 'Explain power');
  assert.equal(stripLeadingEmoji('Plain'), 'Plain');
});
