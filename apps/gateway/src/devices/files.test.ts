import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_DEVICE_FILE_BYTES, saveDeviceFile } from './files';
import { DeviceHub } from './hub';
import { createDeviceRoutes } from './api';

test('binary export is bound to its pending device call and returns only metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-export-'));
  const hub = new DeviceHub();
  const routes = createDeviceRoutes(hub, root);
  try {
    const session = await hub.register('pc', [
      { name: 'filesystem_export', inputSchema: { type: 'object' } },
    ]);
    const call = hub.call('pc', session, 'filesystem_export', {
      path: 'C:\\Admin\\RIB (banque).pdf',
    });
    const [rpc] = await hub.poll('pc', session, new AbortController().signal);
    const bytes = Buffer.from('%PDF-1.7\n\x00\xff\x80\nprivate binary payload', 'latin1');
    const url = `http://localhost/pc/files/${rpc!.id}`;
    const request = (s = session, id = rpc!.id) =>
      new Request(url.replace(rpc!.id, id), {
        method: 'POST',
        headers: { 'X-Device-Session': s, 'Content-Length': String(bytes.length) },
        body: bytes,
      });
    assert.equal((await routes.fetch(request('wrong-session'))).status, 409);
    assert.equal((await routes.fetch(request(session, 'unknown-call'))).status, 409);
    const response = await routes.fetch(request());
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as {
      path: string;
      name: string;
      size: number;
      sha256: string;
      link: string;
    };
    assert.deepEqual(await readFile(join(root, metadata.path)), bytes);
    assert.equal(metadata.size, bytes.length);
    assert.equal(metadata.name, 'RIB (banque).pdf');
    assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.match(metadata.link, /RIB%20%28banque%29.pdf/);
    assert.equal((await routes.fetch(request())).status, 409);
    hub.result('pc', session, rpc!.id, {
      content: [{ type: 'text', text: JSON.stringify(metadata) }],
    });
    const result = await call;
    assert.ok(!JSON.stringify(result).includes('private binary payload'));
    assert.ok(!JSON.stringify(result).includes(bytes.toString('base64')));
    assert.equal((await routes.fetch(request())).status, 409);
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized and incomplete uploads leave no workspace file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-export-'));
  try {
    await assert.rejects(
      saveDeviceFile(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'Content-Length': String(MAX_DEVICE_FILE_BYTES + 1) },
          body: 'x',
        }),
        '/private/RIB.pdf',
        root,
        () => {}
      ),
      /25 MB/
    );
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(
      saveDeviceFile(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'Content-Length': '20' },
          body: 'short',
        }),
        '/private/RIB.pdf',
        root,
        () => {}
      ),
      /Incomplete/
    );
    assert.deepEqual(await readdir(join(root, 'data/device-files')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupted upload is cancelled and its partial file is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-export-'));
  const abort = new AbortController();
  let cancelled = false;
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Length': '100' },
      body: stream,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit);
    const upload = saveDeviceFile(request, '/admin/rib.pdf', root, () => {
      // Abort after the first chunk has reached disk and the reader is waiting.
      setTimeout(() => abort.abort(), 10);
    });
    await assert.rejects(upload);
    assert.ok(cancelled);
    assert.deepEqual(await readdir(join(root, 'data/device-files')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
