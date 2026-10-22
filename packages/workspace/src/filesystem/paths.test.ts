import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspacePathError } from '../transport.ts';
import { toRelativePath } from './paths.ts';
import { globToRegExp, isBinary } from './search.ts';

test('relative paths are normalized to workspace-relative POSIX paths', () => {
  assert.equal(toRelativePath('files/report.xlsx', '/root'), 'files/report.xlsx');
  assert.equal(toRelativePath('./files//a/../b.txt', '/root'), 'files/b.txt');
  assert.equal(toRelativePath('', '/root'), '');
  assert.equal(toRelativePath('.', '/root'), '');
  assert.equal(toRelativePath('dir/', '/root'), 'dir');
});

test('the display root prefix is accepted as the workspace root', () => {
  assert.equal(toRelativePath('/workspace/files/a.txt', '/workspace'), 'files/a.txt');
  assert.equal(toRelativePath('/workspace', '/workspace'), '');
});

test('absolute paths and paths leaving the workspace are rejected', () => {
  assert.throws(() => toRelativePath('/etc/passwd', '/workspace'), WorkspacePathError);
  assert.throws(() => toRelativePath('../secret', '/workspace'), WorkspacePathError);
  assert.throws(() => toRelativePath('a/../../secret', '/workspace'), WorkspacePathError);
  assert.throws(() => toRelativePath('a\0b', '/workspace'), WorkspacePathError);
});

test('glob patterns used for include filters and exclusions', () => {
  assert.ok(globToRegExp('*.ts').test('index.ts'));
  assert.ok(!globToRegExp('*.ts').test('src/index.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
  assert.ok(!globToRegExp('src/**/*.ts').test('lib/b.ts'));
  assert.ok(globToRegExp('file?.md').test('file1.md'));
});

test('binary detection looks for NUL bytes', () => {
  assert.equal(isBinary(new TextEncoder().encode('plain text\n')), false);
  assert.equal(isBinary(new Uint8Array([0x50, 0x00, 0x51])), true);
});
