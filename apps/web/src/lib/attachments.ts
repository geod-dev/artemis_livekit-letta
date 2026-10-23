/** Attachments and other files of the agent's workspace, as the browser sees them. */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Where the browser fetches a workspace file, by its path in the workspace. */
export function workspaceUrl(path: string, { download = false } = {}): string {
  const url = `/api/workspace/${path.split('/').map(encodeURIComponent).join('/')}`;
  return download ? `${url}?download` : url;
}

/**
 * The workspace path a link in an assistant reply points to, or null when it
 * is a web link. The assistant links files by their path relative to the
 * workspace (`files/report.xlsx`); its absolute form in the agent's container
 * (`/workspace/files/report.xlsx`) is accepted too. Markdown rendering resolves
 * relative links against the app's origin, so same-origin links are workspace
 * files.
 */
export function workspacePath(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const path = decodeURIComponent(url.pathname).replace(/^\/(?:(?:api\/)?workspace\/)?/, '');
    return path && !path.endsWith('/') ? path : null;
  } catch {
    return null;
  }
}
