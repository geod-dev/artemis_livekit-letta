import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WorkspacePathError } from '../../transport.ts';
import { FilesystemWorkspaceTransport } from './index.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-write-handle-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('openWrite', () => {
  test('commit moves the streamed chunks into place and leaves no temporary file', async () => {
    await mkdir(join(root, 'commit'), { recursive: true });
    const transport = new FilesystemWorkspaceTransport({ root: join(root, 'commit') });
    const handle = await transport.openWrite('uploads/clip.bin');
    await handle.write(new TextEncoder().encode('first '));
    await handle.write(new TextEncoder().encode('second'));
    await handle.commit('uploads/clip.bin');

    assert.equal(
      await readFile(join(root, 'commit', 'uploads', 'clip.bin'), 'utf8'),
      'first second'
    );
    assert.deepEqual(await readdir(join(root, 'commit', 'uploads')), ['clip.bin']);
  });

  test('abort removes the temporary file and leaves the target untouched', async () => {
    await mkdir(join(root, 'abort'), { recursive: true });
    const transport = new FilesystemWorkspaceTransport({ root: join(root, 'abort') });
    await transport.writeFile('keep.txt', 'original');
    const handle = await transport.openWrite('keep.txt');
    await handle.write(new TextEncoder().encode('partial'));
    await handle.abort();

    assert.equal(await readFile(join(root, 'abort', 'keep.txt'), 'utf8'), 'original');
    assert.deepEqual(await readdir(join(root, 'abort')), ['keep.txt']);
  });

  test('commit rejects a final path outside the root and keeps the handle for abort', async () => {
    await mkdir(join(root, 'escape'), { recursive: true });
    const transport = new FilesystemWorkspaceTransport({ root: join(root, 'escape') });
    const handle = await transport.openWrite('inside.txt');
    await handle.write(new TextEncoder().encode('data'));

    await assert.rejects(handle.commit('../outside.txt'), WorkspacePathError);
    await handle.abort();
    assert.deepEqual(await readdir(join(root, 'escape')), []);
  });
});
