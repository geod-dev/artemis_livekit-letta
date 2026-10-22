import { basename } from 'node:path';
import { TOOL_NAMES } from '../names.ts';
import type { ToolContext } from '../context.ts';
import { capText, errorResult, textResult, type ToolResult } from '../result.ts';
import { Tool } from '../tool.ts';
import { describeBinary, imageType, isTextContent } from './media.ts';

const MAX_READ_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_READ_LINES = 2_000;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
const MAX_MATCH_TEXT = 300;
const MAX_DISPLAY_PATHS = 200;

export class ReadFileTool extends Tool<{ path: string; offset?: number; limit?: number }> {
  readonly name = TOOL_NAMES.readFile;
  readonly description =
    'Read a workspace file. Text comes back with line numbers; long files page with offset (1-based first line) and limit (lines, default 2000). Images are returned for viewing. Other binary files cannot be read.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to show (1-based).' },
      limit: { type: 'integer', minimum: 1, maximum: DEFAULT_READ_LINES, description: 'Number of lines to show.' },
    },
    required: ['path'],
    additionalProperties: false,
  };
  override readonly readOnly = true;

  async execute(input: { path: string; offset?: number; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
    const { path } = input;
    const info = await ctx.workspace.stat(path);
    if (!info) return errorResult(`${path}: no such file.`);
    if (info.type === 'directory') return errorResult(`${path} is a directory; use list_files.`);
    if (info.size > MAX_READ_BYTES) return errorResult(`${path} is ${info.size} bytes; the read limit is ${MAX_READ_BYTES}.`);

    const bytes = await ctx.workspace.readFile(path);
    const display = { type: 'file' as const, operation: 'read' as const, path };
    const image = imageType(bytes);
    if (image) {
      if (bytes.length > MAX_IMAGE_BYTES) return errorResult(`${path} is too large to show (${bytes.length} bytes).`);
      return {
        content: [
          { type: 'text', text: `Image ${path} (${image}, ${bytes.length} bytes).` },
          { type: 'image', mediaType: image, data: Buffer.from(bytes).toString('base64') },
        ],
        isError: false,
        display,
      };
    }
    if (!isTextContent(bytes)) {
      return errorResult(`${path} is a ${describeBinary(bytes)} and cannot be read as text.`);
    }

    const text = Buffer.from(bytes).toString('utf8');
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    const total = lines.length;
    const start = (input.offset ?? 1) - 1;
    if (start > 0 && start >= total) return errorResult(`${path} has ${total} lines; offset ${input.offset} is past the end.`);
    const count = input.limit ?? DEFAULT_READ_LINES;
    const shown = lines.slice(start, start + count);
    const numbered = shown.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
    const last = start + shown.length;
    const footer = last < total ? `\n\n[Lines ${start + 1}-${last} of ${total} shown; continue with offset ${last + 1}.]` : '';
    return textResult(capText(numbered, `continue with offset and limit`) + footer, {
      display: { ...display, lines: { offset: start + 1, count: shown.length, total } },
    });
  }
}

export class WriteFileTool extends Tool<{ path: string; content: string }> {
  readonly name = TOOL_NAMES.writeFile;
  readonly description =
    'Create or overwrite a workspace file with the given content (parent directories are created). Use edit_file for changes to existing files.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Complete file content.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  };

  async execute(input: { path: string; content: string }, ctx: ToolContext): Promise<ToolResult> {
    ctx.workspace.assertWritable(input.path, ctx.access);
    const existed = (await ctx.workspace.stat(input.path)) !== null;
    await ctx.workspace.writeFile(input.path, input.content);
    return textResult(`${existed ? 'Overwrote' : 'Created'} ${input.path} (${Buffer.byteLength(input.content)} bytes).`, {
      display: { type: 'file', operation: 'write', path: input.path },
    });
  }
}

export class EditFileTool extends Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> {
  readonly name = TOOL_NAMES.editFile;
  readonly description =
    'Replace an exact text span in a workspace file. old_string must occur exactly once unless replace_all is true; include enough surrounding text to make it unique.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      old_string: { type: 'string', minLength: 1, description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  };

  async execute(
    input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const { path, old_string: oldText, new_string: newText } = input;
    ctx.workspace.assertWritable(path, ctx.access);
    if (oldText === newText) return errorResult('old_string and new_string are identical.');
    const info = await ctx.workspace.stat(path);
    if (!info) return errorResult(`${path}: no such file.`);
    if (info.type !== 'file') return errorResult(`${path} is not a regular file.`);
    const bytes = await ctx.workspace.readFile(path);
    if (!isTextContent(bytes)) return errorResult(`${path} is a ${describeBinary(bytes)}; only text files can be edited.`);

    const text = Buffer.from(bytes).toString('utf8');
    const occurrences = text.split(oldText).length - 1;
    if (occurrences === 0) return errorResult(`old_string was not found in ${path}.`);
    if (occurrences > 1 && !input.replace_all) {
      return errorResult(
        `old_string occurs ${occurrences} times in ${path}; include more surrounding text to make it unique, or set replace_all.`
      );
    }
    const updated = input.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    await ctx.workspace.writeFile(path, updated);
    return textResult(`Edited ${path}: replaced ${input.replace_all ? occurrences : 1} occurrence(s).`, {
      display: { type: 'file', operation: 'edit', path },
    });
  }
}

export class DeleteFileTool extends Tool<{ path: string }> {
  readonly name = TOOL_NAMES.deleteFile;
  readonly description = 'Delete one workspace file. Directories are not removed.';
  readonly inputSchema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative path of the file.' } },
    required: ['path'],
    additionalProperties: false,
  };

  async execute(input: { path: string }, ctx: ToolContext): Promise<ToolResult> {
    ctx.workspace.assertWritable(input.path, ctx.access);
    const info = await ctx.workspace.stat(input.path);
    if (!info) return errorResult(`${input.path}: no such file.`);
    if (info.type === 'directory') return errorResult(`${input.path} is a directory; delete_file only removes files.`);
    await ctx.workspace.deleteFile(input.path);
    return textResult(`Deleted ${input.path}.`, { display: { type: 'file', operation: 'delete', path: input.path } });
  }
}

export class ListFilesTool extends Tool<{ path?: string }> {
  readonly name = TOOL_NAMES.listFiles;
  readonly description = 'List the entries of a workspace directory (directories first, then files with sizes).';
  readonly inputSchema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative directory (default: the root).' } },
    additionalProperties: false,
  };
  override readonly readOnly = true;

  async execute(input: { path?: string }, ctx: ToolContext): Promise<ToolResult> {
    const path = input.path ?? '.';
    const info = await ctx.workspace.stat(path);
    if (!info) return errorResult(`${path}: no such directory.`);
    if (info.type !== 'directory') return errorResult(`${path} is not a directory.`);
    const entries = (await ctx.workspace.list(path)).sort((a, b) => {
      const dirs = Number(b.type === 'directory') - Number(a.type === 'directory');
      return dirs || (a.path < b.path ? -1 : 1);
    });
    const lines = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => {
      const name = basename(entry.path);
      if (entry.type === 'directory') return `${name}/`;
      if (entry.type === 'symlink') return `${name}@`;
      return `${name}  (${entry.size} bytes)`;
    });
    if (entries.length > MAX_LIST_ENTRIES) lines.push(`[${entries.length - MAX_LIST_ENTRIES} more entries not shown]`);
    return textResult(lines.length ? lines.join('\n') : '(empty directory)', {
      display: {
        type: 'file',
        operation: 'list',
        path,
        paths: entries.slice(0, MAX_DISPLAY_PATHS).map((entry) => entry.path),
      },
    });
  }
}

export class SearchFilesTool extends Tool<{ pattern: string; path?: string; include?: string; case_insensitive?: boolean }> {
  readonly name = TOOL_NAMES.searchFiles;
  readonly description =
    'Search workspace files for a regular expression (ripgrep syntax). Returns path:line: text for up to 200 matches. Binary files and node_modules/.git are skipped.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'Regular expression.' },
      path: { type: 'string', description: 'Workspace-relative directory to search (default: the root).' },
      include: { type: 'string', description: 'Glob of file names to search, e.g. *.ts or src/**/*.md.' },
      case_insensitive: { type: 'boolean' },
    },
    required: ['pattern'],
    additionalProperties: false,
  };
  override readonly readOnly = true;

  async execute(
    input: { pattern: string; path?: string; include?: string; case_insensitive?: boolean },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const path = input.path ?? '.';
    let matches;
    try {
      matches = await ctx.workspace.grep(input.pattern, {
        path,
        include: input.include,
        caseInsensitive: input.case_insensitive,
        limit: MAX_SEARCH_MATCHES,
      });
    } catch (error) {
      return errorResult(`search_files: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (matches.length === 0) return textResult('No matches.', { display: { type: 'file', operation: 'search', path } });
    const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text.slice(0, MAX_MATCH_TEXT)}`);
    if (matches.length >= MAX_SEARCH_MATCHES) {
      lines.push(`[Stopped at ${MAX_SEARCH_MATCHES} matches; narrow the pattern, include or path.]`);
    }
    const paths = [...new Set(matches.map((m) => m.path))].slice(0, MAX_DISPLAY_PATHS);
    return textResult(capText(lines.join('\n'), 'narrow the pattern, include or path'), {
      display: { type: 'file', operation: 'search', path, paths },
    });
  }
}
