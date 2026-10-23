import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../config.ts';
import { imageType, inspectedMimeType, resolveAttachments, saveAttachment } from './workspace-adapter.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('workspace adapter derives uploaded attachment metadata from inspected bytes', async () => {
  const previousRoot = config.workspace.dir;
  const root = await mkdtemp(join(tmpdir(), 'artemis-workspace-adapter-'));
  config.workspace.dir = root;
  try {
    const image = await saveAttachment(new File([PNG], 'image.txt', { type: 'text/plain' }));
    assert.equal(image.kind, 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.size, PNG.length);
    assert.equal(imageType(PNG), 'image/png');
    assert.equal(inspectedMimeType(PNG, 'renamed.txt'), 'image/png');
    assert.deepEqual(await readFile(join(root, image.path)), PNG);

    const [resolved] = await resolveAttachments([{ ...image, name: '', mimeType: 'text/plain' }]);
    assert.equal(resolved.name, 'image.txt');
    assert.equal(resolved.mimeType, 'image/png');
    await assert.rejects(
      resolveAttachments([{ ...image, path: 'data/attachments/none/missing.png' }]),
      /Unknown attachment/
    );
  } finally {
    config.workspace.dir = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
