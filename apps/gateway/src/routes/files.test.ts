import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttachmentStore } from '../assistant/attachments/attachment-store.ts';
import { MAX_ATTACHMENT_BYTES } from '../assistant/attachments/attachment-policy.ts';
import { composeWorkspace } from '../compose.ts';
import { createFileRoutes, planWorkspaceResponse } from './files.ts';

/** The file routes over a workspace rooted at `root`. */
function routesFor(root: string): Hono {
  const workspace = composeWorkspace(root);
  return new Hono().route('/api', createFileRoutes(new AttachmentStore(workspace), workspace));
}

test('workspace file GET and HEAD use inspected MIME and bounded byte ranges', async () => {
  const root = await mkdtemp(join(process.cwd(), '.test-workspace-file-'));
  const app = routesFor(root);
  try {
    await writeFile(join(root, 'note.txt'), 'abcdef');
    const ranged = await app.fetch(new Request('http://localhost/api/workspace/note.txt', {
      headers: { Range: 'bytes=2-4' },
    }));
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(ranged.headers.get('content-range'), 'bytes 2-4/6');
    assert.equal(await ranged.text(), 'cde');

    const head = await app.fetch(new Request('http://localhost/api/workspace/note.txt', { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '6');
    assert.equal(await head.text(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace response planning bounds ranges and preserves HEAD semantics', () => {
  const file = { path: 'images/chart.png', size: 16, contentType: 'image/png', viewable: true };
  const range = planWorkspaceResponse(file, 'GET', false, 'bytes=1-3');
  assert.equal(range.status, 206);
  assert.equal(range.headers['Content-Range'], 'bytes 1-3/16');
  assert.equal(range.headers['Content-Length'], '3');
  assert.deepEqual(range.range, { start: 1, end: 3 });

  const suffix = planWorkspaceResponse(file, 'HEAD', false, 'bytes=-4');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['Content-Range'], 'bytes 12-15/16');
  assert.equal(suffix.headers['Content-Length'], '4');
  assert.equal(suffix.noBody, true);

  const invalid = planWorkspaceResponse(file, 'GET', false, 'bytes=16-');
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['Content-Range'], 'bytes */16');
  assert.equal(invalid.noBody, true);
});

test('upload rejects oversized streamed bodies before multipart parsing without content-length', async () => {
    const root = await mkdtemp(join(process.cwd(), '.test-workspace-upload-'));
    const app = routesFor(root);
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 1024 * 1024 + 1);
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
    assert.match((await response.json() as { error: string }).error, /too large/i);
    await rm(root, { recursive: true, force: true });
});
