import { createContext, useContext } from 'react';
import { DownloadIcon, FileXIcon } from 'lucide-react';
import { getMimeTypeIcon } from '@/components/media/file-icons';
import { invalidateWorkspaceFileInfo, useFileInfo } from '@/hooks/use-file-info';
import { workspaceUrl } from '@/lib/attachments';
import { fileKind } from '@/lib/file-kinds';
import { formatFileSize } from '@/lib/media-format';

/**
 * Files of the agent's workspace that the assistant links in its replies
 * (`[report.xlsx](files/report.xlsx)`, `![chart](files/chart.png)`). Images
 * are shown large, other files as cards; either opens the file in the side
 * panel (see `workspace-file-panel.tsx`), and every file can be downloaded.
 *
 * Markdown puts links inside paragraphs, so everything here is phrasing
 * content (spans, buttons, images).
 */

export function fileName(path: string): string {
  return path.split('/').at(-1) || path;
}

/**
 * Opens a workspace file in the side panel. Without a panel on the page, the
 * file opens in a new tab.
 */
export const WorkspaceFilePanelContext = createContext<(path: string) => void>((path) => {
  window.open(workspaceUrl(path), '_blank', 'noreferrer');
});

/** A linked workspace file on its own line: images are shown, other files are cards. */
export function WorkspaceFileCard({ path }: { path: string }) {
  const info = useFileInfo(path);
  const openFile = useContext(WorkspaceFilePanelContext);
  const name = fileName(path);

  // Until the file's type is known, its name guesses whether it is an image.
  const isImage = info
    ? info.status === 'ready' && info.type.startsWith('image/')
    : fileKind('', name) === 'image';
  if (isImage) return <WorkspaceImage path={path} />;

  if (info?.status === 'missing') {
    return (
      <span className="surface-panel text-muted-foreground my-2 flex w-fit max-w-full items-center gap-4.5 rounded-lg border-dashed px-4.5 py-3 text-sm">
        <FileXIcon aria-hidden className="size-7.5 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
        <span className="shrink-0 text-xs">not found</span>
      </span>
    );
  }

  const type = info?.type ?? '';
  const Icon = getMimeTypeIcon(type, name);
  return (
    <span className="surface-panel has-[button:focus-visible]:ring-ring/50 relative my-2 flex w-fit max-w-full items-center gap-4.5 rounded-lg px-4.5 py-3 text-sm no-underline transition-colors has-[button:focus-visible]:ring-[3px]">
      <Icon aria-hidden className="text-muted-foreground size-7.5 shrink-0" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{name}</span>
        <span className="text-muted-foreground text-xs">
          {info ? formatFileSize(info.size) : '…'}
        </span>
      </span>
      {/* Covers the card, so a click anywhere but the download action opens the file. */}
      <button
        type="button"
        onClick={() => {
          invalidateWorkspaceFileInfo(path);
          openFile(path);
        }}
        aria-label={`Open ${name}`}
        className="absolute inset-0 cursor-pointer rounded-lg outline-none"
      />
      <a
        href={workspaceUrl(path, { download: true })}
        download={name}
        className="text-muted-foreground hover:bg-accent hover:text-accent-foreground relative shrink-0 rounded-md p-1.5 transition-colors"
        aria-label={`Download ${name}`}
      >
        <DownloadIcon className="size-5" />
      </a>
    </span>
  );
}

/** A workspace image, shown large on its own line: opens in the side panel, with a download action. */
export function WorkspaceImage({ path, alt }: { path: string; alt?: string }) {
  const info = useFileInfo(path);
  const openFile = useContext(WorkspaceFilePanelContext);
  if (info?.status === 'missing') return <WorkspaceFileCard path={path} />;
  const name = fileName(path);
  return (
    <span className="group relative my-3 block w-fit max-w-full">
      <button
        type="button"
        onClick={() => {
          invalidateWorkspaceFileInfo(path);
          openFile(path);
        }}
        aria-label={`Open ${alt || name}`}
        className="focus-visible:ring-ring/50 block max-w-full cursor-zoom-in rounded-lg outline-none focus-visible:ring-[3px]"
      >
        <img
          src={workspaceUrl(path)}
          alt={alt || name}
          className="block max-h-[40rem] max-w-full rounded-lg object-contain"
        />
      </button>
      <a
        href={workspaceUrl(path, { download: true })}
        download={name}
        aria-label={`Download ${name}`}
        className="bg-background/80 text-foreground absolute end-2 top-2 rounded-md p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <DownloadIcon className="size-5" />
      </a>
    </span>
  );
}
