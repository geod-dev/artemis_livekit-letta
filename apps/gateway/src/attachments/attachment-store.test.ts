import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { composeWorkspace } from '../compose.ts';
import { InvalidAttachmentError, PayloadTooLargeError } from './attachment-policy.ts';
import { AttachmentStore } from './attachment-store.ts';
import { MAX_UPLOAD_BYTES } from './limits.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('attachment store derives uploaded attachment metadata from inspected bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-store-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-store-state-'));
  try {
    const store = new AttachmentStore(composeWorkspace(root), state);
    const image = await store.save(new File([PNG], 'image.txt', { type: 'text/plain' }));
    assert.equal(image.kind, 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.size, PNG.length);
    assert.deepEqual(await readFile(join(root, image.path)), PNG);

    const resolved = (await store.resolve([{ ...image, name: '', mimeType: 'text/plain' }]))[0];
    assert.ok(resolved);
    assert.equal(resolved.name, 'image.txt');
    assert.equal(resolved.mimeType, 'image/png');
    await assert.rejects(
      store.resolve([{ ...image, path: 'data/attachments/none/missing.png' }]),
      /Unknown attachment/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a file under data/attachments that was never registered is refused as invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-stray-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-stray-state-'));
  try {
    const store = new AttachmentStore(composeWorkspace(root), state);
    const stray = 'data/attachments/0b8f2d3e-1111-4222-8333-444455556666/stray.png';
    await mkdir(dirname(join(root, stray)), { recursive: true });
    await writeFile(join(root, stray), PNG);
    await assert.rejects(
      store.resolve([
        { path: stray, name: 'stray.png', kind: 'image', mimeType: 'image/png', size: PNG.length },
      ]),
      InvalidAttachmentError
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('an upload over the limit is refused before any byte is written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-large-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-large-state-'));
  try {
    const store = new AttachmentStore(composeWorkspace(root), state);
    const oversized = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.bin');
    await assert.rejects(store.save(oversized), PayloadTooLargeError);
    assert.deepEqual(
      await readFile(join(state, 'attachment-retention.json')).catch(() => null),
      null
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
