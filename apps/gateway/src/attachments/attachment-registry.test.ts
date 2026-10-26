import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeWorkspace } from '../compose.ts';
import { AttachmentUnavailableError, attachmentPath } from './attachment-policy.ts';
import { AttachmentStore } from './attachment-store.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const IMAGE = { kind: 'image', mimeType: 'image/png' } as const;

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

test('a first read beside the first save never races the state file', async () => {
  // Round-3 flake: an unserialized first read raced the first rename (EPERM on Windows).
  for (let round = 0; round < 50; round++) {
    const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-race-'));
    const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-race-state-'));
    try {
      const registry = new AttachmentStore(composeWorkspace(root), state).registry;
      const path = attachmentPath(randomUUID(), 'race.png');
      const [before] = await Promise.all([registry.uploadOf(path), registry.register(path, IMAGE)]);
      assert.equal(before, undefined);
      assert.deepEqual(await registry.uploadOf(path), IMAGE);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  }
});

test('reserving an unknown or removed upload keeps nothing and answers unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-reserve-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-reserve-state-'));
  try {
    const registry = new AttachmentStore(composeWorkspace(root), state).registry;
    const known = attachmentPath(randomUUID(), 'known.png');
    const unknown = attachmentPath(randomUUID(), 'unknown.png');
    await registry.register(known, IMAGE);

    await assert.rejects(
      registry.reserveReferences('conversation-a', [known, unknown]),
      AttachmentUnavailableError
    );
    assert.equal(await registry.removeUnused(known), true);

    await registry.register(known, IMAGE);
    const release = await registry.reserveReferences('conversation-b', [known]);
    assert.equal(await registry.removeUnused(known), false);
    await release();
    assert.equal(await registry.removeUnused(known), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a failed save leaves the cached retention state unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-save-fail-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-save-fail-state-'));
  try {
    const registry = new AttachmentStore(composeWorkspace(root), state).registry;
    const upload = attachmentPath(randomUUID(), 'reserved.png');
    await registry.register(upload, IMAGE);

    // The first save fails once; later saves go through the real implementation.
    const internals = registry as unknown as { save: (next: unknown) => Promise<void> };
    const save = internals.save.bind(registry);
    internals.save = async () => {
      internals.save = save;
      throw new Error('disk full');
    };
    await assert.rejects(registry.reserveReferences('conversation-a', [upload]), /disk full/);

    // The refused reservation must not remain in memory, so the upload is still unreferenced.
    assert.equal(await registry.removeUnused(upload), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('an invalid retention record is a load error and is never dropped on save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-invalid-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-invalid-state-'));
  try {
    const text = JSON.stringify({
      files: {
        [attachmentPath(randomUUID(), 'a.png')]: { createdAt: 1, owners: ['conversation-x'] },
      },
    });
    await writeFile(join(state, 'attachment-retention.json'), text);
    const registry = new AttachmentStore(composeWorkspace(root), state).registry;
    await assert.rejects(registry.cleanupAbandoned(), /is invalid/);
    assert.equal(await readFile(join(state, 'attachment-retention.json'), 'utf8'), text);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

const HOUR = 60 * 60 * 1000;

test('an upload shared by two turns stays referenced when the earlier turn is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-shared-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-shared-state-'));
  try {
    const registry = new AttachmentStore(composeWorkspace(root), state).registry;
    const upload = attachmentPath(randomUUID(), 'shared.png');
    await registry.register(upload, IMAGE);

    const rejectedTurn = await registry.reserveReferences('conversation-a', [upload]);
    await registry.reserveReferences('conversation-a', [upload]);
    await rejectedTurn();

    // The accepted turn still references the upload, so it is neither removable nor collectable.
    assert.equal(await registry.removeUnused(upload), false);
    assert.equal(await registry.cleanupAbandoned(Date.now() + 2 * 24 * HOUR), 0);
    assert.deepEqual(await registry.uploadOf(upload), IMAGE);

    // Releasing the conversation (its deletion) drops the accepted turn's reference too.
    await registry.releaseReferences('conversation-a');
    assert.equal(await registry.cleanupAbandoned(Date.now() + 25 * HOUR), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('an upload is kept for the full retention period after it loses its last owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-unref-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-unref-state-'));
  try {
    const uploadedAt = Date.parse('2026-01-01T00:00:00Z');
    let clock = uploadedAt;
    t.mock.method(Date, 'now', () => clock);
    const registry = new AttachmentStore(composeWorkspace(root), state).registry;
    const path = attachmentPath(randomUUID(), 'late.png');
    await registry.register(path, IMAGE);

    // Uploaded three days before the turn is sent and then rejected: it became unreferenced just now.
    clock = uploadedAt + 3 * 24 * HOUR;
    const release = await registry.reserveReferences('conversation-a', [path]);
    await release();

    clock = uploadedAt + 3 * 24 * HOUR + 23 * HOUR;
    assert.equal(await registry.cleanupAbandoned(clock), 0);
    clock = uploadedAt + 3 * 24 * HOUR + 25 * HOUR;
    assert.equal(await registry.cleanupAbandoned(clock), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a retention state written before unreferencedAt existed still loads and releases its owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-attachment-legacy-'));
  const state = await mkdtemp(join(tmpdir(), 'artemis-attachment-legacy-state-'));
  try {
    const path = attachmentPath(randomUUID(), 'legacy.png');
    await writeFile(
      join(state, 'attachment-retention.json'),
      JSON.stringify({
        files: { [path]: { ...IMAGE, createdAt: 0, owners: ['conversation-x'] } },
      })
    );
    const registry = new AttachmentStore(composeWorkspace(root), state).registry;
    const released = Date.now();
    await registry.releaseReferences('conversation-x');
    assert.equal(await registry.cleanupAbandoned(released + 23 * HOUR), 0);
    assert.equal(await registry.cleanupAbandoned(released + 25 * HOUR), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
