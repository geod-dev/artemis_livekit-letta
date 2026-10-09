/** One result of an Exa web search. */
export interface WebResult {
  title: string;
  url: string;
  /** ISO date, when Exa knows it. */
  published?: string;
  author?: string;
  /** A short plain-text excerpt of the page. */
  snippet: string;
}

export interface WebSearchOutput {
  results: WebResult[];
  /** The output was cut short: there were more results than these. */
  truncated: boolean;
}

/** Letta's cut of long Bash output, or the MCP bridge's cut of a long tool result. */
const TRUNCATION =
  /\n*(?:\[Output truncated: [^\]]*\](?:\n\[Full output written to: [^\]]*\])?|\[Cut at [\d,]+ characters[^\]]*\])\s*$/;
const FIELD = /^(Title|URL|Published|Author):[ \t]*(.*)$/;
const SNIPPET_CHARS = 280;

/**
 * Read the result of Exa's `web_search_exa` tool: one `Title: / URL: /
 * Published: / Author: / Highlights:` block per result, separated by `---`.
 * Through the MCP bridge (`mcp_call`) the result is that text; from Bash
 * (`letta mcp call`, the `mcp-servers` skill's wrapper) it is the MCP result
 * as JSON, which Letta cuts short when long, so its text is read leniently.
 * Returns null when no result can be read.
 */
export function parseWebSearchResult(result: unknown): WebSearchOutput | null {
  if (typeof result !== 'string') return null;
  const truncated = TRUNCATION.test(result);
  const body = result.replace(TRUNCATION, '');
  const results = searchText(body)
    .split(/\n-{3,}\n/)
    .flatMap((block) => {
      const parsed = parseBlock(block);
      return parsed ? [parsed] : [];
    });
  return results.length > 0 ? { results, truncated } : null;
}

/** The text of the MCP result, or the output itself when it is not one. */
function searchText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return body;
  try {
    const parsed = JSON.parse(trimmed) as { content?: { text?: unknown }[] };
    return (parsed.content ?? []).map((part) => String(part.text ?? '')).join('\n---\n');
  } catch {
    const start = /"text"\s*:\s*"/.exec(trimmed);
    return start ? decodeJsonString(trimmed.slice(start.index + start[0].length)) : '';
  }
}

/** A JSON string's value up to its closing quote, or as far as it goes when cut short. */
function decodeJsonString(source: string): string {
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') break;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = source[++i];
    if (next === undefined) break;
    if (next === 'u') {
      const code = Number.parseInt(source.slice(i + 1, i + 5), 16);
      if (Number.isNaN(code)) break;
      out += String.fromCharCode(code);
      i += 4;
    } else {
      out += escapes[next] ?? next;
    }
  }
  return out;
}

function parseBlock(block: string): WebResult | null {
  const fields: Record<string, string> = {};
  const lines = block.trim().split('\n');
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (/^Highlights:/.test(line)) {
      index++;
      break;
    }
    const field = FIELD.exec(line);
    if (field) fields[field[1]] = field[2].trim();
  }
  const url = fields.URL;
  if (!url || !/^https?:\/\//.test(url)) return null;
  // Exa writes N/A for what it does not know; a page without a title goes by its site.
  const title = known(fields.Title) ? fields.Title : siteOf(url);
  return {
    title,
    url,
    ...(known(fields.Published) ? { published: fields.Published } : {}),
    ...(known(fields.Author) ? { author: fields.Author } : {}),
    snippet: excerpt(lines.slice(index).join('\n'), title),
  };
}

const known = (value: string | undefined): value is string =>
  value !== undefined && value !== '' && value !== 'N/A';

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Page metadata some highlights start with, e.g. `Author: … Published: …`. */
const METADATA_LINE = /^\s*(Author|Published|Source|Language|Title|URL):/;

/** Highlights as one short line of prose: no markdown, tables, or repeated title. */
function excerpt(highlights: string, title: string): string {
  const text = highlights
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line) && !METADATA_LINE.test(line)) // tables, metadata
    .map((line) => line.replace(/^\s*#+\s*/, '')) // headings
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTitle = (text.startsWith(title) ? text.slice(title.length) : text)
    .replace(/^[\s.…,:;|–-]+/, '') // the cut-off end of a previous sentence
    .trim();
  return withoutTitle.length > SNIPPET_CHARS
    ? `${withoutTitle.slice(0, SNIPPET_CHARS).replace(/\s+\S*$/, '')}…`
    : withoutTitle;
}
