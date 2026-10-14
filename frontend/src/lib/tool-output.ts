/** Safe, display-oriented view of a tool result. Raw MCP media bytes never belong in the UI. */
export type ToolArtifactReference = {
  name: string;
  url: string;
  kind: string;
};

export type ToolOutputView = {
  text: string;
  artifacts: ToolArtifactReference[];
  isEnvelope: boolean;
};

const ARTIFACT_MARKER = /\[\[mcp-managed-artifacts:v1:[0-9a-f-]{36}\]\]/gi;

export function formatToolValue(value: unknown, space?: number): string {
  if (typeof value === 'string') return value;
  try {
    if (value instanceof Error) return String(value);
    const json = JSON.stringify(value, null, space);
    if (json !== undefined) return json;
  } catch {}
  try {
    return String(value);
  } catch {
    return '[Unserializable value]';
  }
}

/**
 * Decode the MCP bridge's serialized CallToolResult envelope. Only content
 * text and safe workspace URLs are exposed; artifact paths and other metadata
 * remain internal. Plain and legacy serialized results stay readable.
 */
export function readToolOutput(value: unknown): ToolOutputView {
  if (typeof value !== 'string') {
    return { text: formatToolValue(value), artifacts: [], isEnvelope: false };
  }

  const source = value.replace(ARTIFACT_MARKER, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // The bridge prepends user-facing attachment markdown before the full
    // serialized envelope. Prefer the envelope's safe mapped references.
    const start = source.indexOf('\n{');
    if (start === -1) return { text: source, artifacts: [], isEnvelope: false };
    try {
      parsed = JSON.parse(source.slice(start + 1).trim());
    } catch {
      return { text: source, artifacts: [], isEnvelope: false };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text: source, artifacts: [], isEnvelope: false };
  }

  const envelope = parsed as { content?: unknown };
  if (!Array.isArray(envelope.content)) {
    return { text: source, artifacts: [], isEnvelope: false };
  }

  const texts: string[] = [];
  const artifacts: ToolArtifactReference[] = [];
  for (const block of envelope.content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (typeof item.text === 'string') texts.push(item.text);

    const artifact =
      item.type === 'resource' && item.resource && typeof item.resource === 'object'
        ? (item.resource as Record<string, unknown>)
        : item;
    const metadata =
      artifact.artifact && typeof artifact.artifact === 'object'
        ? (artifact.artifact as Record<string, unknown>)
        : undefined;
    if (
      typeof artifact.workspaceUrl === 'string' &&
      /^\/api\/workspace\//.test(artifact.workspaceUrl)
    ) {
      artifacts.push({
        name:
          typeof metadata?.name === 'string'
            ? metadata.name
            : typeof artifact.name === 'string'
              ? artifact.name
              : 'MCP attachment',
        url: artifact.workspaceUrl,
        kind: typeof item.type === 'string' ? item.type : 'file',
      });
    }
  }
  return { text: texts.join('\n\n'), artifacts, isEnvelope: true };
}

/** Plain text shared by tool-specific parsers, with compatibility for MCP envelopes. */
export function toolOutputText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const view = readToolOutput(value);
  return view.isEnvelope ? view.text : value.replace(ARTIFACT_MARKER, '').trim();
}
