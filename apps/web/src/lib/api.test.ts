import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { apiFetch, requestJson, responseJson } from './api.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const isNumber = (value: unknown): value is number => typeof value === 'number';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error & { status?: number | null }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status?: number | null };
  }
  assert.fail('expected the promise to reject');
}

test('a request that gets no response becomes an ApiError with a null status', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const error = await rejection(apiFetch('/api/conversations'));
  assert.equal(error.name, 'ApiError');
  assert.equal(error.message, 'fetch failed');
  assert.equal(error.status, null);
});

test('a network failure without a message uses the generic connection text', async () => {
  globalThis.fetch = async () => {
    throw 'offline';
  };
  const error = await rejection(apiFetch('/api/conversations'));
  assert.equal(error.message, 'Unable to connect to the server');
  assert.equal(error.status, null);
});

test('an aborted request passes its AbortError through unchanged', async () => {
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  globalThis.fetch = async () => {
    throw abort;
  };
  const error = await rejection(apiFetch('/api/conversations'));
  assert.equal(error, abort);
});

test('a successful response is returned as is', async () => {
  const response = jsonResponse({ ok: true });
  globalThis.fetch = async () => response;
  assert.equal(await apiFetch('/api/conversations'), response);
});

test('responseJson reports invalid JSON on an OK response', async () => {
  const error = await rejection(
    responseJson(new Response('<html>', { status: 200 }), isNumber, 'Fallback')
  );
  assert.equal(error.message, 'Server returned invalid JSON');
  assert.equal(error.status, 200);
});

test('responseJson uses the fallback when a failed response is not JSON', async () => {
  const error = await rejection(
    responseJson(new Response('<html>', { status: 502 }), isNumber, 'Unable to load')
  );
  assert.equal(error.message, 'Unable to load');
  assert.equal(error.status, 502);
});

test('responseJson prefers the server error text of a failed JSON response', async () => {
  const error = await rejection(
    responseJson(jsonResponse({ error: 'Incorrect password.' }, 401), isNumber, 'Unable to load')
  );
  assert.equal(error.message, 'Incorrect password.');
  assert.equal(error.status, 401);
});

test('responseJson falls back when a failed JSON response has no error text', async () => {
  const error = await rejection(
    responseJson(jsonResponse({ detail: 'nope' }, 500), isNumber, 'Unable to load')
  );
  assert.equal(error.message, 'Unable to load');
});

test('responseJson returns a value that passes validation', async () => {
  assert.equal(await responseJson(jsonResponse(42), isNumber, 'Fallback'), 42);
});

test('responseJson rejects an OK response that fails validation', async () => {
  const error = await rejection(responseJson(jsonResponse('not a number'), isNumber, 'Fallback'));
  assert.equal(error.message, 'Server returned an unexpected response');
  assert.equal(error.status, 200);
});

test('requestJson validates the body of a successful request', async () => {
  globalThis.fetch = async () => jsonResponse({ count: 'three' });
  const error = await rejection(requestJson('/api/count', { method: 'GET' }, isNumber, 'Fallback'));
  assert.equal(error.message, 'Server returned an unexpected response');
});

test('requestJson returns the validated body', async () => {
  globalThis.fetch = async () => jsonResponse(3);
  assert.equal(await requestJson('/api/count', { method: 'GET' }, isNumber, 'Fallback'), 3);
});
