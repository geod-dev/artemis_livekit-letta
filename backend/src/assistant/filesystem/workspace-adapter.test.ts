import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../config.ts';
import { imageType, inspectedMimeType, saveMcpArtifact } from './workspace-adapter.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('workspace adapter derives uploaded artifact metadata from inspected bytes', async () => {
  const previousRoot = config.workspace.dir;
  const root = await mkdtemp(join(tmpdir(), 'livekit-letta-workspace-adapter-'));
  config.workspace.dir = root;
  try {
    const image = await saveMcpArtifact({ bytes: PNG, mimeType: 'text/plain', name: 'image.txt' });
    assert.equal(image.kind, 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.size, PNG.length);
    assert.equal(imageType(PNG), 'image/png');
    assert.equal(inspectedMimeType(PNG, 'renamed.txt'), 'image/png');
    assert.deepEqual(await readFile(join(root, image.path)), PNG);
  } finally {
    config.workspace.dir = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
