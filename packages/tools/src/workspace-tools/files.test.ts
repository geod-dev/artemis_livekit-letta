import { WorkspacePathError, sniffMedia } from '@artemis/workspace';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeWorkspace, testContext } from '../testing/fake-workspace.ts';
import { EditFileTool, ReadFileTool, WriteFileTool } from './files.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

test('read_file numbers lines and pages with offset and limit', async () => {
  const workspace = new FakeWorkspace();
  workspace.addText('notes.txt', 'alpha\nbeta\ngamma\n');

  const result = await new ReadFileTool().execute(
    { path: 'notes.txt', offset: 2, limit: 1 },
    testContext(workspace)
  );

  assert.equal(result.isError, false);
  assert.equal(textOf(result), '     2\tbeta\n\n[Lines 2-2 of 3 shown; continue with offset 3.]');
});

test('read_file returns an image for viewing', async () => {
  const workspace = new FakeWorkspace();
  await workspace.writeFile('shot.png', PNG);

  const result = await new ReadFileTool().execute({ path: 'shot.png' }, testContext(workspace));

  assert.equal(result.isError, false);
  assert.equal(result.content[1]?.type, 'image');
  assert.equal(result.content[1]?.type === 'image' && result.content[1].mediaType, 'image/png');
});

test('read_file refuses binary content that is not an image, naming its kind', async () => {
  const workspace = new FakeWorkspace();
  await workspace.writeFile('bundle.xlsx', ZIP);

  const result = await new ReadFileTool().execute({ path: 'bundle.xlsx' }, testContext(workspace));

  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    'bundle.xlsx is a zip archive (xlsx, docx, pptx, ...) and cannot be read as text.'
  );
});

test('write_file refuses paths under a read-only prefix', async () => {
  const workspace = new FakeWorkspace();

  await assert.rejects(
    new WriteFileTool().execute({ path: 'data/state.json', content: '{}' }, testContext(workspace)),
    WorkspacePathError
  );
  assert.equal(workspace.files.has('data/state.json'), false);
});

test('edit_file requires a unique match unless replace_all is set', async () => {
  const workspace = new FakeWorkspace();
  workspace.addText('draft.md', 'x x');
  const tool = new EditFileTool();

  const ambiguous = await tool.execute(
    { path: 'draft.md', old_string: 'x', new_string: 'y' },
    testContext(workspace)
  );
  assert.equal(ambiguous.isError, true);
  assert.match(textOf(ambiguous), /occurs 2 times/);

  const all = await tool.execute(
    { path: 'draft.md', old_string: 'x', new_string: 'y', replace_all: true },
    testContext(workspace)
  );
  assert.equal(all.isError, false);
  assert.equal(await workspace.readText('draft.md'), 'y y');
});

test('edit_file refuses binary files with their kind', async () => {
  const workspace = new FakeWorkspace();
  await workspace.writeFile('bundle.xlsx', ZIP);

  const result = await new EditFileTool().execute(
    { path: 'bundle.xlsx', old_string: 'a', new_string: 'b' },
    testContext(workspace)
  );

  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    'bundle.xlsx is a zip archive (xlsx, docx, pptx, ...); only text files can be edited.'
  );
});

test('a binary file is labelled from its signature', () => {
  const bytes = (text: string, prefix: number[] = []) =>
    new Uint8Array([...prefix, ...Buffer.from(text, 'latin1')]);
  const label = (data: Uint8Array) => sniffMedia(data).label;

  assert.equal(label(bytes('%PDF-1.7\n')), 'PDF document');
  assert.equal(
    label(bytes('\x03\x04\x00\x00', [0x50, 0x4b])),
    'zip archive (xlsx, docx, pptx, ...)'
  );
  assert.equal(label(bytes('RIFF\x00\x00\x00\x00WAVE')), 'WAV audio');
  assert.equal(label(bytes('OggS\x00')), 'Ogg audio');
  assert.equal(label(bytes('\x00\x00\x00\x18ftypmp42')), 'MPEG-4 media');
  assert.equal(label(new Uint8Array([0, 1, 2, 3])), 'binary data');
});
