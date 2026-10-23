import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../config.ts';
import {
  addAttachmentReferences,
  cleanupAbandonedAttachments,
  releaseAttachmentReferences,
  removeUnusedAttachment,
  setAttachmentReferences,
} from './attachment-retention.ts';
import { saveAttachment } from './workspace-adapter.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('referenced uploads survive restarts and are collected once released and abandoned', async () => {
  const previousRoot = config.workspace.dir;
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-retention-'));
  const otherRoot = await mkdtemp(join(tmpdir(), 'artemis-attachment-restart-'));
  config.workspace.dir = root;
  try {
    const upload = await saveAttachment(new File([PNG], 'upload.png', { type: 'image/png' }));
    await addAttachmentReferences('conversation-test', [upload]);

    // Switching roots forces retention state to be loaded from disk again, as on process restart.
    config.workspace.dir = otherRoot;
    await cleanupAbandonedAttachments();
    config.workspace.dir = root;
    const expiredAt = Date.now() + 25 * 60 * 60 * 1000;
    assert.equal(await cleanupAbandonedAttachments(expiredAt), 0);
    assert.deepEqual(await readFile(join(root, upload.path)), PNG);
    assert.equal(await removeUnusedAttachment(upload.path), false);

    await releaseAttachmentReferences('conversation-test');
    assert.equal(await cleanupAbandonedAttachments(expiredAt), 1);
    await assert.rejects(readFile(join(root, upload.path)));

    const orphan = await saveAttachment(new File([Buffer.from('orphan')], 'orphan.txt'));
    assert.equal(await removeUnusedAttachment(orphan.path), true);
    await assert.rejects(readFile(join(root, orphan.path)));

    const replaced = await saveAttachment(new File([PNG], 'replaced.png'));
    await addAttachmentReferences('conversation-test', [replaced]);
    await setAttachmentReferences('conversation-test', []);
    assert.equal(await removeUnusedAttachment(replaced.path), true);

    await mkdir(join(root, 'files'), { recursive: true });
    await writeFile(join(root, 'files', 'user-output.txt'), 'user output');
    assert.equal(await removeUnusedAttachment('files/user-output.txt'), false);
    assert.equal(await readFile(join(root, 'files', 'user-output.txt'), 'utf8'), 'user output');
  } finally {
    config.workspace.dir = previousRoot;
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});
