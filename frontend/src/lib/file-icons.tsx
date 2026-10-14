import type { FC } from 'react';
import {
  BracesIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  MusicIcon,
  VideoIcon,
  createLucideIcon,
} from 'lucide-react';
import { type FileKind, fileKind } from './file-kinds';

const FileMarkdownIcon = createLucideIcon('file-markdown', [
  [
    'path',
    {
      d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      key: 'outline',
    },
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'fold' }],
  ['path', { d: 'M7 18v-5l2 2 2-2v5', key: 'm' }],
  ['path', { d: 'M16 13v5', key: 'stem' }],
  ['path', { d: 'm14 16 2 2 2-2', key: 'head' }],
]);

const KIND_ICONS: Record<FileKind, FC<{ className?: string }>> = {
  image: ImageIcon,
  audio: MusicIcon,
  video: VideoIcon,
  pdf: FileTextIcon,
  markdown: FileMarkdownIcon,
  json: BracesIcon,
  text: FileTextIcon,
  other: FileIcon,
};

/** Pick one icon consistently from the shared MIME type and filename rules. */
export function getMimeTypeIcon(mimeType: string, name?: string): FC<{ className?: string }> {
  return KIND_ICONS[fileKind(mimeType, name)];
}
