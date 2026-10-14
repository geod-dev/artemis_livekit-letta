import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../config.ts';
import {
  claimAttachmentReferenceToken,
  cleanupAbandonedAttachments,
  createAttachmentReferenceToken,
  releaseAttachmentReferences,
  removeUnusedAttachment,
} from './attachment-retention.ts';
import { saveAttachment, saveMcpArtifact } from './workspace-adapter.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('MCP outputs survive restart and TTL while abandoned uploads are collected', async () => {
  const previousRoot = config.workspace.dir;
  const root = await mkdtemp(join(tmpdir(), 'livekit-letta-attachment-retention-'));
  const otherRoot = await mkdtemp(join(tmpdir(), 'livekit-letta-attachment-restart-'));
  config.workspace.dir = root;
  try {
    const output = await saveMcpArtifact({ bytes: PNG, mimeType: 'text/plain', name: 'generated.png' });
    const token = await createAttachmentReferenceToken([output.path]);
    assert.ok(token);
    const persisted = JSON.parse(await readFile(join(root, 'data/attachment-retention.json'), 'utf8')) as {
      files: Record<string, { kind: string }>;
      tokens: Record<string, { paths: string[] }>;
    };
    assert.equal(persisted.files[output.path]?.kind, 'mcp-output');
    assert.deepEqual(persisted.tokens[token]?.paths, [output.path]);

    // Switching roots forces retention state to be loaded from disk again, as on process restart.
    config.workspace.dir = otherRoot;
    await cleanupAbandonedAttachments();
    config.workspace.dir = root;
    const expiredAt = Date.now() + 25 * 60 * 60 * 1000;
    assert.equal(await cleanupAbandonedAttachments(expiredAt), 0);
    assert.deepEqual(await readFile(join(root, output.path)), PNG);
    assert.equal(await claimAttachmentReferenceToken('conversation-test', token), true);
    await releaseAttachmentReferences('conversation-test');
    assert.equal(await cleanupAbandonedAttachments(expiredAt), 0);
    assert.equal(await removeUnusedAttachment(output.path), false);
    assert.deepEqual(await readFile(join(root, output.path)), PNG);

    const upload = await saveAttachment(new File([PNG], 'upload.png', { type: 'image/png' }));
    assert.equal(await cleanupAbandonedAttachments(expiredAt), 1);
    await assert.rejects(readFile(join(root, upload.path)));

    const orphan = await saveAttachment(new File([Buffer.from('orphan')], 'orphan.txt'));
    assert.equal(await removeUnusedAttachment(orphan.path), true);
    await assert.rejects(readFile(join(root, orphan.path)));

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

test('pending artifact token state is bounded without evicting live handoffs', async () => {
  const previousRoot = config.workspace.dir;
  const root = await mkdtemp(join(tmpdir(), 'livekit-letta-attachment-token-cap-'));
  config.workspace.dir = root;
  try {
    const createdAt = Date.now();
    const tokens = Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [
      `pending-${index}`,
      { createdAt, paths: ['data/attachments/00000000-0000-0000-0000-000000000000/kept.png'] },
    ]));
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data/attachment-retention.json'), JSON.stringify({ files: {}, tokens }));
    await assert.rejects(
      createAttachmentReferenceToken(['data/attachments/00000000-0000-0000-0000-000000000001/new.png']),
      /capacity reached/,
    );
  } finally {
    config.workspace.dir = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
