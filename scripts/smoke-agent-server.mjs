/**
 * Live smoke test of an already-running agent-server. Not part of the default test run.
 *
 * Reads AGENT_SERVER_URL and AGENT_SERVER_TOKEN from the root .env (the process
 * environment is the fallback). Values are never printed. It creates a conversation,
 * subscribes to its event stream, posts a text turn "smoke", and waits up to 90 s for
 * the turn's turn_end event. It also requires that the assistant produced text.
 *
 * Usage: node scripts/smoke-agent-server.mjs
 * Prints PASS or FAIL with the reason; exits 1 on FAIL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TURN_TIMEOUT_MS = 90_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SmokeFailure extends Error {}

function readDotEnv(path) {
  const values = new Map();
  if (!existsSync(path)) return values;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

/** A short, non-sensitive description of a network error (never the URL or token). */
function errorCode(error) {
  return error?.cause?.code ?? error?.code ?? error?.name ?? 'error';
}

const dotEnv = readDotEnv(join(ROOT, '.env'));
const baseUrl = (dotEnv.get('AGENT_SERVER_URL') ?? process.env.AGENT_SERVER_URL ?? '').replace(/\/+$/, '');
const token = dotEnv.get('AGENT_SERVER_TOKEN') ?? process.env.AGENT_SERVER_TOKEN ?? '';

async function api(method, path, body) {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SmokeFailure(`${method} ${path} could not reach the agent-server (${errorCode(error)})`);
  }
}

/** Parses the SSE stream of one conversation into an event list that can be waited on. */
class EventFeed {
  events = [];
  closed = false;
  error = null;
  waiters = [];

  constructor(body, signal) {
    this.pump(body, signal);
  }

  async pump(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) this.events.push(JSON.parse(line.slice('data: '.length)));
          }
          end = buffer.indexOf('\n\n');
        }
        this.notify();
      }
    } catch (error) {
      if (!signal.aborted) this.error = error;
    } finally {
      this.closed = true;
      this.notify();
    }
  }

  notify() {
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** The first event matching `predicate`, or undefined after `timeoutMs`. */
  async waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (this.closed) {
        const reason = this.error ? `event stream failed (${errorCode(this.error)})` : 'event stream closed';
        throw new SmokeFailure(reason);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

async function run() {
  if (!baseUrl) throw new SmokeFailure('AGENT_SERVER_URL is not set in the root .env');
  if (!token) throw new SmokeFailure('AGENT_SERVER_TOKEN is not set in the root .env');

  const created = await api('POST', '/v1/conversations', {});
  if (created.status !== 201) throw new SmokeFailure(`creating a conversation returned HTTP ${created.status}`);
  const { id } = await created.json();
  if (!UUID.test(id)) throw new SmokeFailure('the created conversation id is not a UUID');

  try {
    const controller = new AbortController();
    const stream = await api('GET', `/v1/conversations/${id}/events`);
    if (stream.status !== 200 || !stream.body) {
      controller.abort();
      throw new SmokeFailure(`opening the event stream returned HTTP ${stream.status}`);
    }
    const feed = new EventFeed(stream.body, controller.signal);
    try {
      const snapshot = await feed.waitFor((event) => event.type === 'snapshot', SNAPSHOT_TIMEOUT_MS);
      if (!snapshot) throw new SmokeFailure('the event stream sent no snapshot');

      const accepted = await api('POST', `/v1/conversations/${id}/turns`, { text: 'smoke' });
      if (accepted.status !== 202) throw new SmokeFailure(`posting the turn returned HTTP ${accepted.status}`);
      const { turnId } = await accepted.json();

      const end = await feed.waitFor(
        (event) => event.type === 'turn_end' && event.turnId === turnId,
        TURN_TIMEOUT_MS
      );
      if (!end) throw new SmokeFailure(`no turn_end within ${TURN_TIMEOUT_MS / 1000} s`);
      if (!end.success) {
        const error = typeof end.error === 'string' ? end.error.slice(0, 300) : 'no error reported';
        throw new SmokeFailure(`the turn ended with an error: ${error}`);
      }

      const replied = feed.events.some(
        (event) =>
          event.turnId === turnId &&
          ((event.type === 'assistant_delta' && event.text?.length > 0) ||
            (event.type === 'message' && event.message?.role === 'assistant'))
      );
      if (!replied) throw new SmokeFailure('the turn ended successfully but the assistant produced no reply');
      return `turn ${turnId} completed with an assistant reply`;
    } finally {
      controller.abort();
    }
  } finally {
    await api('DELETE', `/v1/conversations/${id}`).catch(() => undefined);
  }
}

try {
  const detail = await run();
  console.log(`PASS: ${detail}`);
} catch (error) {
  const reason = error instanceof SmokeFailure ? error.message : `unexpected error (${errorCode(error)})`;
  console.log(`FAIL: ${reason}`);
  process.exitCode = 1;
}
