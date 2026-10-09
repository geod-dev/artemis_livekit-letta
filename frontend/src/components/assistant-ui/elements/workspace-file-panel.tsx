import { useEffect, useState } from 'react';
import { DownloadIcon, FileXIcon, XIcon } from 'lucide-react';
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button';
import { workspaceUrl } from '@/lib/attachments';
import { fileKind, isTextKind } from '@/lib/file-kinds';
import { formatFileSize, getMimeTypeIcon } from './file';
import { MarkdownDocument } from './markdown-text';
import { type FileInfo, fileName, useFileInfo } from './workspace-file';

/**
 * The side panel that shows a workspace file opened from a file card: media
 * and PDFs the browser displays itself, markdown rendered, other text and code
 * as plain text, anything else as its icon and name.
 */

/** Text larger than this is not previewed: the panel would stall rendering it. */
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'text';

function previewKind(name: string, info: FileInfo & { status: 'ready' }): PreviewKind | null {
  const kind = fileKind(info.type, name);
  if (isTextKind(kind)) {
    if (info.size > TEXT_PREVIEW_LIMIT) return null;
    return kind === 'markdown' ? 'markdown' : 'text';
  }
  return kind === 'other' ? null : kind;
}

function TextPreview({ path, markdown }: { path: string; markdown?: boolean }) {
  const [entry, setEntry] = useState<{ path: string; text: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    fetch(workspaceUrl(path))
      .then((res) => (res.ok ? res.text() : null))
      .catch(() => null)
      .then((text) => {
        if (active) setEntry({ path, text });
      });
    return () => {
      active = false;
    };
  }, [path]);

  if (entry?.path !== path) {
    return <p className="text-muted-foreground p-6 text-sm">Loading…</p>;
  }
  if (entry.text === null) {
    return <p className="text-muted-foreground p-6 text-sm">This file could not be loaded.</p>;
  }
  if (markdown) return <MarkdownDocument text={entry.text} className="p-6" />;
  return (
    <pre className="min-h-full p-6 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
      {entry.text}
    </pre>
  );
}

/** The file's icon with its name under it, centered; audio adds its player below. */
function FileIdentity({
  name,
  type,
  children,
}: {
  name: string;
  type: string;
  children?: React.ReactNode;
}) {
  const Icon = getMimeTypeIcon(type, name);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Icon aria-hidden className="text-muted-foreground size-16" />
      <span className="max-w-full text-sm font-medium break-all">{name}</span>
      {children}
    </div>
  );
}

function Preview({ path, name, info }: { path: string; name: string; info: FileInfo | null }) {
  if (!info) return <p className="text-muted-foreground p-6 text-sm">Loading…</p>;
  if (info.status === 'missing') {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <FileXIcon aria-hidden className="size-16" />
        <span className="max-w-full text-sm break-all">{name} was not found</span>
      </div>
    );
  }
  const url = workspaceUrl(path);
  switch (previewKind(name, info)) {
    case 'image':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <img src={url} alt={name} className="max-h-full max-w-full rounded-md object-contain" />
        </div>
      );
    case 'audio':
      return (
        <FileIdentity name={name} type={info.type}>
          <audio src={url} controls className="mt-2 w-full max-w-md" />
        </FileIdentity>
      );
    case 'video':
      return (
        <div className="flex h-full items-center justify-center bg-black">
          <video src={url} controls className="max-h-full max-w-full" />
        </div>
      );
    case 'pdf':
      return <iframe src={url} title={name} className="size-full border-0" />;
    case 'markdown':
      return <TextPreview path={path} markdown />;
    case 'text':
      return <TextPreview path={path} />;
    default:
      return <FileIdentity name={name} type={info.type} />;
  }
}

/** A workspace file opened beside the conversation. */
export function WorkspaceFilePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const info = useFileInfo(path);
  const name = fileName(path);
  const Icon = getMimeTypeIcon(info?.status === 'ready' ? info.type : '', name);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <aside
      aria-label={name}
      className="bg-background border-border/70 animate-in fade-in-0 slide-in-from-right-8 fixed inset-0 z-40 flex flex-col duration-200 ease-out motion-reduce:animate-none md:static md:inset-auto md:z-auto md:w-[min(42rem,45vw)] md:shrink-0 md:border-s"
    >
      <header className="flex h-16 shrink-0 items-center gap-2.5 border-b px-4">
        <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 truncate text-sm font-medium" title={path}>
          {name}
        </span>
        {info?.status === 'ready' && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {formatFileSize(info.size)}
          </span>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <TooltipIconButton tooltip="Download" asChild className="size-8 p-1.5">
            <a href={workspaceUrl(path, { download: true })} download={name}>
              <DownloadIcon className="size-4" />
            </a>
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Close"
            type="button"
            onClick={onClose}
            className="size-8 p-1.5"
          >
            <XIcon className="size-4" />
          </TooltipIconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Preview key={path} path={path} name={name} info={info} />
      </div>
    </aside>
  );
}
