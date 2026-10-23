import { useEffect, useState } from 'react';
import { FileXIcon } from 'lucide-react';
import {
  type FileInfo,
  fileName,
  useFileInfo,
} from '@/components/assistant-ui/files/workspace-file';
import { MarkdownDocument } from '@/components/assistant-ui/markdown/markdown-text';
import { workspaceUrl } from '@/lib/attachments';
import { getMimeTypeIcon } from '@/lib/file-icons';
import { fileKind, isTextKind } from '@/lib/file-kinds';

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

/** Reusable preview inside the Files / Tasks workspace. */
export function WorkspaceFilePreview({ path }: { path: string }) {
  const info = useFileInfo(path);
  return <Preview key={path} path={path} name={fileName(path)} info={info} />;
}
