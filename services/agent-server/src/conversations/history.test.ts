import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BackgroundUpdateRecord, MessageRecord, ToolCallRecord, UserTurnEnvelope } from '@artemis/storage';
import { projectHistory, updateLabel } from './history.ts';

const NOW = '2026-10-22T10:00:00.000Z';

function envelope(overrides: Partial<UserTurnEnvelope> = {}): UserTurnEnvelope {
  return {
    version: 2,
    mode: 'text',
    text: 'Hello',
    currentDateTime: NOW,
    attachments: [],
    updates: [],
    recalledMemories: [],
    ...overrides,
  };
}

function message(overrides: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'role'>): MessageRecord {
  return {
    conversationId: 'conv_1',
    taskId: null,
    turnId: 'turn_1',
    seq: 1,
    content: [],
    envelope: null,
    provider: null,
    model: null,
    providerMessageId: null,
    stopReason: null,
    usage: null,
    timings: null,
    createdAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function call(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id'>): ToolCallRecord {
  return {
    conversationId: 'conv_1',
    taskId: null,
    turnId: 'turn_1',
    assistantMessageId: 'msg_a',
    name: 'bash',
    input: { command: 'ls' },
    status: 'completed',
    resultText: 'a.txt',
    isError: false,
    display: null,
    taskRef: null,
    startedAt: NOW,
    endedAt: NOW,
    ...overrides,
  };
}

describe('projectHistory', () => {
  it('projects a user turn with its delivered updates, then the assistant blocks and tool rows', () => {
    const messages = [
      message({
        id: 'msg_u',
        role: 'user',
        envelope: envelope({
          text: 'List my files',
          attachments: [{ path: 'data/attachments/x/a.png', name: 'a.png', kind: 'image' }],
          clientMessageId: 'client-1',
          updates: [
            {
              id: 'upd_1',
              taskId: 'task_1',
              title: 'Research',
              status: 'completed',
              needsInput: false,
              report: 'Done.',
              durationMs: 1200,
            },
          ],
        }),
      }),
      message({
        id: 'msg_a',
        role: 'assistant',
        seq: 2,
        content: [
          { type: 'reasoning', text: 'Think first' },
          { type: 'text', text: 'Here they are.' },
          { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
        ],
      }),
      message({ id: 'msg_result', role: 'user', seq: 3, content: [{ type: 'tool_result', toolUseId: 'call_1' }] }),
    ];

    const rows = projectHistory({
      messages,
      toolCalls: [call({ id: 'call_1', assistantMessageId: 'msg_a', resultText: 'a.txt' })],
      updates: [],
    });

    assert.deepEqual(
      rows.map((row) => row.id),
      ['upd_1', 'msg_u', 'msg_a:0', 'msg_a:1', 'call_1']
    );
    assert.deepEqual(rows[0], {
      id: 'upd_1',
      role: 'event',
      kind: 'task_result',
      text: 'Research completed',
      updateId: 'upd_1',
      taskId: 'task_1',
      status: 'completed',
      durationMs: 1200,
      detail: 'Done.',
      createdAt: NOW,
    });
    assert.deepEqual(rows[1], {
      id: 'msg_u',
      role: 'user',
      text: 'List my files',
      modality: 'text',
      attachments: [{ path: 'data/attachments/x/a.png', name: 'a.png', kind: 'image' }],
      clientMessageId: 'client-1',
      createdAt: NOW,
    });
    assert.deepEqual(rows[2], { id: 'msg_a:0', role: 'reasoning', text: 'Think first', createdAt: NOW });
    assert.deepEqual(rows[4], {
      id: 'call_1',
      role: 'tool',
      toolCallId: 'call_1',
      name: 'bash',
      args: '{"command":"ls"}',
      result: 'a.txt',
      isError: false,
      createdAt: NOW,
    });
  });

  it('joins tool display, task reference and errors from the tool call record', () => {
    const rows = projectHistory({
      messages: [
        message({ id: 'msg_a', role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'run_agent', input: {} }] }),
      ],
      toolCalls: [
        call({
          id: 'call_2',
          name: 'run_agent',
          status: 'backgrounded',
          resultText: 'started',
          isError: true,
          display: { type: 'agent', taskId: 'task_9', subagentType: 'research', title: 'Look', prompt: 'p' },
          taskRef: { taskId: 'task_9', kind: 'agent', relation: 'started' },
        }),
      ],
      updates: [],
    });
    const row = rows[0];
    assert.ok(row?.role === 'tool');
    assert.equal(row.isError, true);
    assert.deepEqual(row.task, { taskId: 'task_9', kind: 'agent', relation: 'started' });
    assert.equal(row.display?.type, 'agent');
  });

  it('skips update-only turns without text, tool result carriers, subagent transcripts and deleted rows', () => {
    const rows = projectHistory({
      messages: [
        message({ id: 'msg_update', role: 'user', envelope: envelope({ text: '', mode: 'voice-short' }) }),
        message({ id: 'msg_task', role: 'assistant', taskId: 'task_1', content: [{ type: 'text', text: 'internal' }] }),
        message({ id: 'msg_gone', role: 'assistant', deletedAt: NOW, content: [{ type: 'text', text: 'rewound' }] }),
      ],
      toolCalls: [],
      updates: [],
    });
    assert.deepEqual(rows, []);
  });

  it('marks unread event rows from the update records and maps voice turns to voice modality', () => {
    const update: BackgroundUpdateRecord = {
      id: 'upd_2',
      conversationId: 'conv_1',
      taskId: 'task_2',
      title: 'Build',
      status: 'failed',
      needsInput: true,
      report: 'Needs a token.',
      durationMs: null,
      depth: 0,
      delivery: 'delivered',
      deliveryToken: null,
      deliveryFrom: null,
      deliveredTurnId: 'turn_1',
      unread: true,
      createdAt: NOW,
      deliveredAt: NOW,
      readAt: null,
    };
    const rows = projectHistory({
      messages: [
        message({
          id: 'msg_v',
          role: 'user',
          envelope: envelope({
            mode: 'voice-long',
            text: 'Anything new?',
            updates: [{ id: 'upd_2', taskId: 'task_2', title: 'Build', status: 'failed', needsInput: true, report: 'Needs a token.' }],
          }),
        }),
      ],
      toolCalls: [],
      updates: [update],
    });
    assert.equal(rows[0]?.role, 'event');
    assert.equal(rows[0]?.role === 'event' && rows[0].unread, true);
    assert.equal(rows[0]?.role === 'event' && rows[0].text, 'Build needs your input');
    assert.equal(rows[1]?.role === 'user' && rows[1].modality, 'voice');
  });
});

describe('updateLabel', () => {
  it('labels each outcome', () => {
    assert.equal(updateLabel('T', 'completed', false), 'T completed');
    assert.equal(updateLabel('T', 'failed', false), 'T failed');
    assert.equal(updateLabel('T', 'cancelled', false), 'T cancelled');
    assert.equal(updateLabel('T', 'completed', true), 'T needs your input');
  });
});
