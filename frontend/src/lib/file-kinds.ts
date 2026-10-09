/**
 * What kind of file something is, from its MIME type and name: the one place
 * that knows file extensions. File icons and the side panel's previews both
 * follow it.
 *
 * Workspaces serve every text format as `text/plain`, so a name can refine a
 * text type (`notes.md` is markdown); specific types win over names.
 */

export type FileKind = 'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'json' | 'text' | 'other';

// prettier-ignore
const KIND_EXTENSIONS: Record<Exclude<FileKind, 'other'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown'],
  json: ['json', 'jsonl', 'ndjson', 'json5', 'geojson'],
  text: [
    // Prose and data
    'txt', 'text', 'mdx', 'rst', 'adoc', 'org', 'tex', 'log', 'csv', 'tsv', 'ipynb', 'xml',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'srt', 'vtt', 'diff', 'patch',
    // Web
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts',
    'tsx', 'vue', 'svelte', 'astro', 'graphql', 'gql',
    // Code
    'py', 'pyi', 'rb', 'php', 'pl', 'lua', 'r', 'jl', 'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp',
    'hxx', 'cs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'go', 'rs', 'swift', 'm', 'mm',
    'dart', 'zig', 'nim', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'lisp', 'scm', 'f90', 'asm', 's',
    'proto', 'sql', 'prisma', 'tf', 'hcl', 'cmake', 'mk',
    // Shell
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  ],
};

const EXTENSION_KINDS = new Map(
  Object.entries(KIND_EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind as FileKind] as const)
  )
);

/** Text files known by their whole name. */
// prettier-ignore
const TEXT_NAMES = new Set([
  'makefile', 'dockerfile', 'containerfile', 'gemfile', 'procfile', 'readme', 'license',
  'changelog', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.env',
]);

function typeKind(type: string): FileKind | null {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/markdown') return 'markdown';
  if (type === 'application/json') return 'json';
  if (type.startsWith('text/')) return 'text';
  return null;
}

function nameKind(name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return 'text';
  const dot = lower.lastIndexOf('.');
  return (dot > 0 && EXTENSION_KINDS.get(lower.slice(dot + 1))) || null;
}

export function fileKind(type: string, name = ''): FileKind {
  const byType = typeKind(type.toLowerCase());
  const byName = nameKind(name);
  if (!byType) return byName ?? 'other';
  if (byType === 'text' && (byName === 'markdown' || byName === 'json')) return byName;
  return byType;
}

/** Kinds read as text: markdown, JSON, code and other plain text. */
export function isTextKind(kind: FileKind): kind is 'markdown' | 'json' | 'text' {
  return kind === 'markdown' || kind === 'json' || kind === 'text';
}
