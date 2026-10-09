import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import activate from './notifications.mjs';

const notification = (id) => `<task-notification>
<task-id>${id}</task-id>
<status>completed</status>
<summary>Agent "x" completed</summary>
<result>done</result>
</task-notification>
Full transcript available at: /tmp/${id}.log`;

/** Activate the mod against a stub gateway; returns its turn_start handler and the requests. */
async function setup(status = 202) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(status).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ASSISTANT_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LETTA_SERVER_TOKEN = 'token';
  let handler;
  const reports = [];
  activate({
    capabilities: { events: { turns: true } },
    events: { on: (name, fn) => { assert.equal(name, 'turn_start'); handler = fn; return () => {}; } },
    diagnostics: { report: (r) => reports.push(r) },
  });
  return { handler, requests, reports, close: () => new Promise((r) => server.close(r)) };
}

const event = (input) => ({ agentId: 'agent-1', conversationId: 'conv-1', input });

test('a turn made only of notifications is handed to the gateway and cancelled', async () => {
  const { handler, requests, close } = await setup();
  try {
    const result = await handler(event([
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>' }, { type: 'text', text: notification('task_1') }] },
    ]));
    assert.ok(result.cancel.reason);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, 'Bearer token');
    assert.deepEqual(requests[0].body, { agentId: 'agent-1', conversationId: 'conv-1', notifications: [notification('task_1')] });
  } finally {
    await close();
  }
});

test('user words in the same turn are kept without the notifications', async () => {
  const { handler, close } = await setup();
  try {
    const result = await handler(event([
      { role: 'user', content: notification('task_2') },
      { role: 'user', content: '[text] hello' },
    ]));
    assert.deepEqual(result, { input: [{ role: 'user', content: '[text] hello' }] });
  } finally {
    await close();
  }
});

test('turns without notifications, and reflection displays, are untouched', async () => {
  const { handler, requests, close } = await setup();
  try {
    assert.equal(await handler(event([{ role: 'user', content: '[voice-short] hi' }])), undefined);
    const reflection = '<task-notification><summary>Reflected</summary><reflection-agent-id>a</reflection-agent-id></task-notification>';
    assert.equal(await handler(event([{ role: 'user', content: reflection }])), undefined);
    assert.equal(requests.length, 0);
  } finally {
    await close();
  }
});

test('when the gateway does not take them, Letta delivers them natively', async () => {
  const { handler, reports, close } = await setup(503);
  try {
    assert.equal(await handler(event([{ role: 'user', content: notification('task_3') }])), undefined);
    assert.equal(reports.length, 1);
  } finally {
    await close();
  }
});
