import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, relative, resolve } from 'node:path';
import type { GrepMatch } from '../transport.ts';
import { toPosix } from './paths.ts';

/** Files above this size are skipped by the JavaScript fallback. */
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
/** Directories never searched (the same defaults as `glob`). */
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

export interface TextSearchRequest {
  pattern: string;
  /** Canonical workspace root (matches are reported relative to it). */
  root: string;
  /** Canonical directory to search, inside `root`. */
  dir: string;
  include?: string;
  caseInsensitive?: boolean;
  limit: number;
}

/**
 * Regex search over workspace files: `rg --json` when ripgrep is on the PATH
 * (`ripgrep: 'auto'`), otherwise a JavaScript walk. Neither follows symlinks.
 */
export class TextSearch {
  private ripgrep: Promise<boolean> | null = null;

  constructor(private readonly mode: 'auto' | 'off') {}

  async grep(request: TextSearchRequest): Promise<GrepMatch[]> {
    if (await this.ripgrepAvailable()) return this.runRipgrep(request);
    return this.walk(request);
  }

  private ripgrepAvailable(): Promise<boolean> {
    if (this.mode === 'off') return Promise.resolve(false);
    this.ripgrep ??= new Promise<boolean>((resolve) => {
      const child = spawn('rg', ['--version'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    return this.ripgrep;
  }

  private async runRipgrep(request: TextSearchRequest): Promise<GrepMatch[]> {
    const args = ['--json', '--no-config', '--color', 'never', '--glob', '!.git', '--glob', '!node_modules'];
    if (request.caseInsensitive) args.push('--ignore-case');
    if (request.include) args.push('--glob', request.include);
    args.push('-e', request.pattern, '--', request.dir);

    const child = spawn('rg', args, { cwd: request.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < 4_000) stderr += data.toString('utf8');
    });

    const matches: GrepMatch[] = [];
    let limitReached = false;
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    await new Promise<void>((resolve) => {
      lines.on('line', (line) => {
        if (limitReached) return;
        const match = parseRipgrepLine(line, request.root);
        if (!match) return;
        matches.push(match);
        if (matches.length >= request.limit) {
          limitReached = true;
          child.kill();
          resolve();
        }
      });
      lines.on('close', () => resolve());
    });

    const code = await exit;
    // rg exits 1 when nothing matched and 2 on errors (for example an invalid pattern).
    if (!limitReached && code === 2) throw new Error(stderr.trim() || 'ripgrep failed');
    return matches;
  }

  private async walk(request: TextSearchRequest): Promise<GrepMatch[]> {
    const regex = new RegExp(request.pattern, request.caseInsensitive ? 'i' : '');
    const include = request.include ? { glob: request.include, regex: globToRegExp(request.include) } : null;
    const matches: GrepMatch[] = [];

    const visit = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        if (matches.length >= request.limit) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path);
        } else if (entry.isFile() && matchesInclude(include, entry.name, path, request.dir)) {
          await searchFile(path, request, regex, matches);
        }
      }
    };
    await visit(request.dir);
    return matches;
  }
}

interface RipgrepEvent {
  type?: string;
  data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
}

function parseRipgrepLine(line: string, root: string): GrepMatch | null {
  let event: RipgrepEvent;
  try {
    event = JSON.parse(line) as RipgrepEvent;
  } catch {
    return null;
  }
  const text = event.data?.path?.text;
  if (event.type !== 'match' || typeof text !== 'string') return null;
  return {
    path: toPosix(relative(root, resolve(root, text))),
    line: event.data?.line_number ?? 0,
    text: (event.data?.lines?.text ?? '').replace(/\r?\n$/, ''),
  };
}

/** A pattern with a slash matches the path below the search directory; one without matches the file name. */
function matchesInclude(include: { glob: string; regex: RegExp } | null, name: string, path: string, dir: string): boolean {
  if (!include) return true;
  return include.regex.test(include.glob.includes('/') ? toPosix(relative(dir, path)) : name);
}

async function searchFile(path: string, request: TextSearchRequest, regex: RegExp, matches: GrepMatch[]): Promise<void> {
  let bytes: Buffer;
  try {
    if ((await stat(path)).size > MAX_FALLBACK_FILE_BYTES) return;
    bytes = await readFile(path);
  } catch {
    return; // Vanished or unreadable: skipped, as rg does.
  }
  if (isBinary(bytes)) return;
  const lines = bytes.toString('utf8').split('\n');
  const rel = toPosix(relative(request.root, path));
  for (let i = 0; i < lines.length && matches.length < request.limit; i++) {
    const text = lines[i]!.replace(/\r$/, '');
    if (regex.test(text)) matches.push({ path: rel, line: i + 1, text });
  }
}

/** NUL bytes in the first 8 KB mark a binary file. */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/** `*`, `?`, `**` and `**\/` glob syntax as a RegExp anchored at both ends. */
export function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${source}$`);
}
