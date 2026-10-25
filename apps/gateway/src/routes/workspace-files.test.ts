import type { WorkspaceTransport } from '@artemis/workspace';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeWorkspace } from '../compose.ts';
import { describeWorkspaceFile } from '../workspace/describe.ts';
import { createWorkspaceFileRoutes, planWorkspaceResponse } from './workspace-files.ts';

/** The workspace file routes over a workspace rooted at `root`. */
function routesFor(root: string): Hono {
  return new Hono().route('/api', createWorkspaceFileRoutes(composeWorkspace(root)));
}

test('workspace file GET and HEAD use inspected MIME and bounded byte ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-workspace-file-'));
  const app = routesFor(root);
  try {
    await writeFile(join(root, 'note.txt'), 'abcdef');
    const ranged = await app.fetch(
      new Request('http://localhost/api/workspace/note.txt', {
        headers: { Range: 'bytes=2-4' },
      })
    );
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(ranged.headers.get('content-range'), 'bytes 2-4/6');
    assert.equal(await ranged.text(), 'cde');

    const head = await app.fetch(
      new Request('http://localhost/api/workspace/note.txt', { method: 'HEAD' })
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '6');
    assert.equal(await head.text(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlink to a workspace file is served under the target name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artemis-workspace-link-'));
  const app = routesFor(root);
  try {
    await writeFile(join(root, 'report.txt'), 'linked body');
    try {
      await symlink(join(root, 'report.txt'), join(root, 'shared.txt'), 'file');
    } catch (error) {
      // On Windows, file symlinks need developer mode or a privilege. CI must have them, so it fails;
      // elsewhere the served name is checked through the fixture instead. Nothing is skipped.
      if (process.env.CI) throw error;
      await checkLinkedFixture();
      return;
    }
    const inline = await app.fetch(new Request('http://localhost/api/workspace/shared.txt'));
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-disposition'), "inline; filename*=UTF-8''report.txt");
    assert.equal(await inline.text(), 'linked body');

    const download = await app.fetch(
      new Request('http://localhost/api/workspace/shared.txt?download')
    );
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get('content-disposition'),
      "attachment; filename*=UTF-8''report.txt"
    );
    await download.text();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A link is described and served under its target's name, checked on a fake workspace (no symlink needed). */
async function checkLinkedFixture(): Promise<void> {
  // stat follows the link, but the name a download reports is the target's (realPath), not the link's.
  const workspace = {
    stat: async (path: string) => ({ path, type: 'file', size: 9, modifiedAt: '' }),
    realPath: async () => 'files/report.txt',
    readStream: async () => new Response('linked body').body!,
  } as unknown as WorkspaceTransport;
  const file = await describeWorkspaceFile(workspace, 'shared/link.txt');
  assert.equal(file?.path, 'files/report.txt');
  const plan = planWorkspaceResponse(file!, 'GET', false, null);
  assert.equal(plan.headers['Content-Disposition'], "inline; filename*=UTF-8''report.txt");
}

test(
  'a linked workspace file is described and served under its target name (no symlink privilege needed)',
  checkLinkedFixture
);

test('workspace response planning bounds ranges and preserves HEAD semantics', () => {
  const file = { path: 'images/chart.png', size: 16, contentType: 'image/png', viewable: true };
  const range = planWorkspaceResponse(file, 'GET', false, 'bytes=1-3');
  assert.equal(range.status, 206);
  assert.equal(range.headers['Content-Range'], 'bytes 1-3/16');
  assert.equal(range.headers['Content-Length'], '3');
  assert.deepEqual(range.range, { start: 1, end: 3 });

  const suffix = planWorkspaceResponse(file, 'HEAD', false, 'bytes=-4');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['Content-Range'], 'bytes 12-15/16');
  assert.equal(suffix.headers['Content-Length'], '4');
  assert.equal(suffix.noBody, true);

  const invalid = planWorkspaceResponse(file, 'GET', false, 'bytes=16-');
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['Content-Range'], 'bytes */16');
  assert.equal(invalid.noBody, true);
});

test('a PDF is never shown inline and is sandboxed like every other file', () => {
  const pdf = {
    path: 'files/report.pdf',
    size: 8,
    contentType: 'application/pdf',
    viewable: false,
  };
  const plan = planWorkspaceResponse(pdf, 'GET', false, null);
  assert.match(plan.headers['Content-Disposition'] ?? '', /^attachment;/);
  assert.equal(plan.headers['Content-Security-Policy'], 'sandbox');
});
