import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeWorkspace } from '../../compose.ts';
import { AttachmentStore } from './attachment-store.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('attachment store derives uploaded attachment metadata from inspected bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-store-'));
  try {
    const store = new AttachmentStore(composeWorkspace(root));
    const image = await store.save(new File([PNG], 'image.txt', { type: 'text/plain' }));
    assert.equal(image.kind, 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.size, PNG.length);
    assert.deepEqual(await readFile(join(root, image.path)), PNG);

    const [resolved] = await store.resolve([{ ...image, name: '', mimeType: 'text/plain' }]);
    assert.equal(resolved.name, 'image.txt');
    assert.equal(resolved.mimeType, 'image/png');
    await assert.rejects(
      store.resolve([{ ...image, path: 'data/attachments/none/missing.png' }]),
      /Unknown attachment/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
