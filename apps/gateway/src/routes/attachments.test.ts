import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttachmentStore } from '../attachments/attachment-store';
import { MAX_UPLOAD_BYTES } from '../attachments/limits';
import { composeWorkspace } from '../compose';
import { createAttachmentRoutes } from './attachments';

test('upload rejects oversized streamed bodies before multipart parsing without content-length', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachments-upload-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachments-upload-state-'));
  try {
    const app = new Hono().route(
      '/api',
      createAttachmentRoutes(new AttachmentStore(composeWorkspace(root), state))
    );
    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1024 * 1024 + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=missing-content-length' },
      body,
      duplex: 'half',
    } as RequestInit);
    const response = await app.fetch(request);
    assert.equal(response.status, 413);
    assert.match(((await response.json()) as { error: string }).error, /too large/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
