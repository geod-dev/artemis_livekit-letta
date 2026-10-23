import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FilesystemWorkspaceTransport } from "./index.ts";

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return Buffer.from(await new Response(stream).arrayBuffer()).toString("utf8");
}

test("readStream streams a whole file or an inclusive byte range", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-stream-"));
  try {
    await writeFile(join(root, "note.txt"), "abcdef");
    const workspace = new FilesystemWorkspaceTransport({ root });
    assert.equal(
      await collect(await workspace.readStream("note.txt")),
      "abcdef",
    );
    assert.equal(
      await collect(
        await workspace.readStream("note.txt", { start: 2, end: 4 }),
      ),
      "cde",
    );
    await assert.rejects(workspace.readStream("missing.txt"));
    await assert.rejects(
      workspace.readStream("../outside.txt"),
      /absolute paths|leaves the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeEmptyDirectory removes only empty directories and tolerates missing ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-rmdir-"));
  try {
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "full"));
    await writeFile(join(root, "full", "kept.txt"), "kept");
    const workspace = new FilesystemWorkspaceTransport({ root });
    await workspace.removeEmptyDirectory("empty");
    await workspace.removeEmptyDirectory("full");
    await workspace.removeEmptyDirectory("never-there");
    assert.equal(await workspace.stat("empty"), null);
    assert.equal((await workspace.stat("full"))?.type, "directory");
    await assert.rejects(workspace.removeEmptyDirectory(""));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
