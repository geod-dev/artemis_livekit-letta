import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BackgroundUpdate,
  decodeUserContent,
  encodeTurn,
  normalizeHistory,
} from './messages.ts';

const update: BackgroundUpdate = {
  id: 'update-1',
  title: 'Best "travel" stroller',
  status: 'completed',
  needsInput: false,
  report: 'Pick the [Babyzen](https://example.com).',
};

test('every turn carries its mode, which sets the modality shown in the chat', () => {
  const voice = encodeTurn('voice-short', 'what time is it');
  assert.match(voice, /^<system-reminder>[^<]*\[listen\][^<]*\[done\][^<]*<\/system-reminder>\n/);
  assert.ok(voice.endsWith('\n[voice-short] what time is it'));
  assert.deepEqual(decodeUserContent(voice), [
    { kind: 'user', text: 'what time is it', modality: 'voice' },
  ]);
  assert.equal(encodeTurn('text', 'hello'), '[text] hello');
  assert.deepEqual(decodeUserContent('[voice-long] keep going'), [
    { kind: 'user', text: 'keep going', modality: 'voice' },
  ]);
  assert.deepEqual(decodeUserContent(encodeTurn('text', 'hello')), [
    { kind: 'user', text: 'hello', modality: 'text' },
  ]);
});

test('turns stored before explicit modes still decode', () => {
  assert.deepEqual(decodeUserContent('[voice] hi'), [
    { kind: 'user', text: 'hi', modality: 'voice' },
  ]);
  assert.deepEqual(decodeUserContent('hi'), [{ kind: 'user', text: 'hi', modality: 'text' }]);
  assert.deepEqual(
    decodeUserContent('<task-result id="t1" task="Strollers" status="failed">\nx\n</task-result>'),
    [{ kind: 'task_result', text: 'Background task failed: Strollers' }]
  );
});

test('system reminders injected by Letta are hidden', () => {
  assert.deepEqual(decodeUserContent('<system-reminder>device info</system-reminder>'), []);
  assert.deepEqual(decodeUserContent('<system-reminder>x</system-reminder>[text] hi'), [
    { kind: 'user', text: 'hi', modality: 'text' },
  ]);
});

test('background updates round-trip with their report, before the user words', () => {
  const failing: BackgroundUpdate = {
    ...update,
    id: 'update-2',
    status: 'failed',
    report: 'Error: </background-update> in output',
  };
  const encoded = encodeTurn('voice-short', 'and the weather?', [update, failing]);
  assert.deepEqual(decodeUserContent(encoded), [
    {
      kind: 'task_result',
      text: 'Background task finished: Best "travel" stroller',
      updateId: 'update-1',
      status: 'completed',
      detail: update.report,
    },
    {
      kind: 'task_result',
      text: 'Background task failed: Best "travel" stroller',
      updateId: 'update-2',
      status: 'failed',
      detail: failing.report,
    },
    { kind: 'user', text: 'and the weather?', modality: 'voice' },
  ]);

  const onlyUpdate = decodeUserContent(encodeTurn('text', '', [{ ...update, needsInput: true }]));
  assert.equal(onlyUpdate.length, 1);
  assert.equal(onlyUpdate[0].text, 'Needs your input: Best "travel" stroller');
});

test('reflection notifications become memory events', () => {
  const reflection =
    '<task-notification><summary>Reflected on conversation</summary><reflection-agent-id>a</reflection-agent-id></task-notification>';
  assert.deepEqual(decodeUserContent(reflection), [{ kind: 'memory', text: 'Memory updated' }]);
});

test('normalizeHistory projects Letta messages into chat rows', () => {
  const rows = normalizeHistory([
    {
      id: 'm1',
      message_type: 'user_message',
      content: [
        { type: 'text', text: '<system-reminder>env</system-reminder>' },
        { type: 'text', text: '[voice-short] research strollers' },
      ],
    },
    { id: 'm2', message_type: 'reasoning_message', reasoning: 'thinking' },
    {
      id: 'm3',
      message_type: 'approval_request_message',
      tool_call: { tool_call_id: 'c1', name: 'Agent', arguments: '{"description":"Strollers"}' },
    },
    {
      id: 'm4',
      message_type: 'tool_return_message',
      tool_call_id: 'c1',
      status: 'success',
      tool_return: 'Task running in background with task ID: task_1',
    },
    { id: 'm5', message_type: 'assistant_message', content: "I'm on it." },
    { id: 'm6', message_type: 'user_message', content: encodeTurn('text', '', [update]) },
  ]);
  assert.deepEqual(
    rows.map((r) => r.role),
    ['user', 'reasoning', 'tool', 'assistant', 'event']
  );
  assert.equal(rows[0].id, 'm1');
  assert.equal(rows[0].role === 'user' && rows[0].modality, 'voice');
  assert.equal(rows[1].role === 'reasoning' && rows[1].text, 'thinking');
  assert.match(rows[2].role === 'tool' ? (rows[2].result ?? '') : '', /task_1/);
  assert.equal(rows[4].role === 'event' && rows[4].updateId, 'update-1');
});

test('attachments are tags with their workspace path and come back on the user message', () => {
  const attachment = {
    path: 'data/attachments/0b6f7a3e-1111-4222-8333-944445555666/report "Q3".pdf',
    name: 'report "Q3".pdf',
    kind: 'file' as const,
    mimeType: 'application/pdf',
    size: 42,
  };
  const encoded = encodeTurn('text', 'summarize this', [], [attachment]);
  assert.match(
    encoded,
    /^\[text\]\n<attachment kind="file" path="data\/attachments\/0b6f7a3e-[^"]+\/report &quot;Q3&quot;.pdf" /
  );
  assert.deepEqual(decodeUserContent(encoded), [
    { kind: 'user', text: 'summarize this', modality: 'text', attachments: [attachment] },
  ]);
  // A message can be attachments only.
  assert.deepEqual(decodeUserContent(encodeTurn('text', '', [], [attachment])), [
    { kind: 'user', text: '', modality: 'text', attachments: [attachment] },
  ]);
  // Earlier turns: a reminder, and the file's id in the former attachments folder.
  const legacy =
    '<system-reminder>The user attached files.</system-reminder>\n[text]\n' +
    '<attachment kind="image" local_path="/workspace/attachments/a/b.png" attachment_id="a/b.png" name="b.png" />\nlook';
  assert.deepEqual(decodeUserContent(legacy), [
    {
      kind: 'user',
      text: 'look',
      modality: 'text',
      attachments: [{ path: 'data/attachments/a/b.png', name: 'b.png', kind: 'image' }],
    },
  ]);
  // Tags the user typed are just text.
  assert.deepEqual(decodeUserContent('[text] see <attachment attachment_id="x" />'), [
    { kind: 'user', text: 'see <attachment attachment_id="x" />', modality: 'text' },
  ]);
});
