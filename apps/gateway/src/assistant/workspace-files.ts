import { type WorkspaceTransport, inspectedMimeType } from '@artemis/workspace';

/** Leading bytes that decide how a workspace file is served. */
const SERVING_SNIFF_BYTES = 8192;

export interface WorkspaceFileInfo {
  path: string;
  size: number;
  contentType: string;
  /** Whether a browser may display the file inline, rather than offering a download. */
  viewable: boolean;
}

/**
 * A file in the workspace, described for serving: its type is sniffed from its
 * leading bytes, and whether a browser may show it. Null when the path names no
 * regular file, or resolves outside the workspace.
 */
export async function describeWorkspaceFile(
  workspace: WorkspaceTransport,
  path: string
): Promise<WorkspaceFileInfo | null> {
  const info = await workspace.stat(path).catch(() => null);
  if (info?.type !== 'file') return null;
  const prefix = await readPrefix(workspace, path, SERVING_SNIFF_BYTES);
  const contentType = inspectedMimeType(prefix);
  const viewable =
    /^(image|audio|video)\//.test(contentType) ||
    contentType === 'application/pdf' ||
    contentType === 'application/json' ||
    contentType.startsWith('text/');
  return { path, size: info.size, contentType, viewable };
}

async function readPrefix(
  workspace: WorkspaceTransport,
  path: string,
  length: number
): Promise<Uint8Array> {
  const stream = await workspace.readStream(path, { start: 0, end: length - 1 });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
