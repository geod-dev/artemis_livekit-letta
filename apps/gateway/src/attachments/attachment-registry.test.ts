import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeWorkspace } from '../compose';
import { AttachmentStore } from './attachment-store';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('referenced uploads survive restarts and are collected once released and abandoned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-registry-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-state-'));
  const workspace = composeWorkspace(root);
  try {
    const before = new AttachmentStore(workspace, state);
    const upload = await before.save(new File([PNG], 'upload.png', { type: 'image/png' }));
    await before.registry.addReferences('conversation-test', [upload.path]);

    // A new store and registry load the retention state from disk, as after a process restart.
    const restarted = new AttachmentStore(workspace, state);
    const registry = restarted.registry;
    const expiredAt = Date.now() + 25 * 60 * 60 * 1000;
    assert.equal(await registry.cleanupAbandoned(expiredAt), 0);
    assert.deepEqual(await readFile(join(root, upload.path)), PNG);
    assert.equal(await registry.removeUnused(upload.path), false);

    await registry.releaseReferences('conversation-test');
    assert.equal(await registry.cleanupAbandoned(expiredAt), 1);
    await assert.rejects(readFile(join(root, upload.path)));

    const orphan = await restarted.save(new File([Buffer.from('orphan')], 'orphan.txt'));
    assert.equal(await registry.removeUnused(orphan.path), true);
    await assert.rejects(readFile(join(root, orphan.path)));

    const replaced = await restarted.save(new File([PNG], 'replaced.png'));
    await registry.addReferences('conversation-test', [replaced.path]);
    await registry.setReferences('conversation-test', []);
    assert.equal(await registry.removeUnused(replaced.path), true);

    await mkdir(join(root, 'files'), { recursive: true });
    await writeFile(join(root, 'files', 'user-output.txt'), 'user output');
    assert.equal(await registry.removeUnused('files/user-output.txt'), false);
    assert.equal(await readFile(join(root, 'files', 'user-output.txt'), 'utf8'), 'user output');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('unreadable retention state is an error, never an empty state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-corrupt-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-corrupt-state-'));
  try {
    await writeFile(join(state, 'attachment-retention.json'), '{not json');
    const store = new AttachmentStore(composeWorkspace(root), state);
    await assert.rejects(store.registry.cleanupAbandoned());
    assert.equal(await readFile(join(state, 'attachment-retention.json'), 'utf8'), '{not json');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
