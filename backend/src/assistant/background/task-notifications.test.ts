import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wakesThread } from './policy.ts';
import { extractTaskNotifications, parseBackgroundStart } from './task-notifications.ts';

test('native worker usage provides its execution duration without leaking metadata into the report', () => {
  const raw = '<task-notification><task-id>task_1</task-id><status>completed</status><summary>Done</summary><result>42</result><usage>total_tokens: 100\ntool_uses: 1\nduration_ms: 28222</usage></task-notification>';
  const [parsed] = extractTaskNotifications(raw).notifications;
  assert.equal(parsed.durationMs, 28222);
  assert.equal(parsed.report, '42');
  assert.equal(extractTaskNotifications(raw.replace('28222', '-1')).notifications[0].durationMs, undefined);
});

// Formats as produced by Letta Code 0.34.4 (Task tool and formatTaskNotification).
const started = `Task running in background with task ID: task_3
Agent ID: agent-local-worker
Conversation ID: local-conv-worker
Output file: /tmp/letta-background-x/task_3.log

You will be notified automatically when this task completes.`;

const notification = (status: string, report: string) => `<task-notification>
<task-id>task_3</task-id>
<status>${status}</status>
<summary>Agent "Compare strollers" ${status}</summary>
<result>subagent_type=research subagent_id=sa-1 subagent_status=${status === 'completed' ? 'success' : 'error'} agent_id=agent-local-worker conversation_id=local-conv-worker

${report}</result>
<usage>total_tokens: 10
tool_uses: 2
duration_ms: 900</usage>
</task-notification>
Full transcript available at: /tmp/letta-background-x/task_3.log`;

test('the Agent tool result identifies the worker', () => {
  assert.deepEqual(parseBackgroundStart(started), {
    taskId: 'task_3',
    workerAgentId: 'agent-local-worker',
    workerConversationId: 'local-conv-worker',
  });
  assert.equal(parseBackgroundStart('Error: unknown subagent type'), null);
});

test('commands Letta moves to the background are identified too', () => {
  assert.deepEqual(
    parseBackgroundStart(
      'Command running in background with ID: bash_3\nOutput file: /tmp/x/bash_3.log'
    ),
    { taskId: 'bash_3' }
  );
  assert.deepEqual(
    parseBackgroundStart(
      'Command is still running with task ID: bash_2\nOutput file: /tmp/x/bash_2.log'
    ),
    { taskId: 'bash_2' }
  );
});

test('quoted receipts and task references in command output cannot create phantom tasks', () => {
  assert.equal(parseBackgroundStart(started, 'command'), null);
  assert.equal(parseBackgroundStart('Command is still running with task ID: bash_2', 'agent'), null);
  for (const output of [
    `Log excerpt:\n${started}`,
    'Found task ID: task_3 in messages.jsonl',
    'Report mentions (task task_3)',
    'Task running in background with task ID: task_3\\nAgent ID: worker',
    JSON.stringify({ content: started }),
  ]) assert.equal(parseBackgroundStart(output), null);
});

test('notifications are extracted with their report, status and worker', () => {
  const text = `<system-reminder>x</system-reminder>${notification('completed', 'Buy A &amp; B &lt;now&gt;')}`;
  const { notifications, rest } = extractTaskNotifications(text);
  assert.equal(rest, '<system-reminder>x</system-reminder>');
  assert.deepEqual(notifications, [
    {
      taskId: 'task_3',
      status: 'completed',
      summary: 'Agent "Compare strollers" completed',
      report: 'Buy A & B <now>',
      durationMs: 900,
      subagentType: 'research',
      workerConversationId: 'local-conv-worker',
      needsInput: false,
    },
  ]);
});

test('a report that starts with the marker needs the user', () => {
  const [n] = extractTaskNotifications(
    notification('completed', 'NEEDS USER INPUT: Which city?')
  ).notifications;
  assert.equal(n.needsInput, true);
});

test('reflection displays and monitor events are not task results', () => {
  const reflection =
    '<task-notification><summary>Reflected</summary><reflection-agent-id>a</reflection-agent-id></task-notification>';
  assert.deepEqual(extractTaskNotifications(reflection).notifications, []);
});

test('short calls hold successful results; failures and questions always wake', () => {
  const ok = { status: 'completed' as const, needsInput: false, depth: 0 };
  assert.equal(wakesThread(ok, 'voice-short'), false);
  assert.equal(wakesThread(ok, 'voice-long'), true);
  assert.equal(wakesThread(ok, 'text'), true);
  assert.equal(wakesThread({ ...ok, status: 'failed' }, 'voice-short'), true);
  assert.equal(wakesThread({ ...ok, needsInput: true }, 'voice-short'), true);
});

test('deliberate stops and work started by updates never wake the thread', () => {
  assert.equal(wakesThread({ status: 'cancelled', needsInput: false, depth: 0 }, 'text'), false);
  assert.equal(wakesThread({ status: 'failed', needsInput: true, depth: 1 }, 'text'), false);
});
