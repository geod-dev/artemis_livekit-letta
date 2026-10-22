import type { ToolDisplay } from '@shared/chat-types';
import { workspaceUrl } from './attachments.ts';

/** Safe, display-oriented view of a tool result. Raw MCP media bytes never belong in the UI. */
export type ToolArtifactReference = {
  name: string;
  url: string;
  kind: string;
};

export type ToolOutputView = {
  text: string;
  artifacts: ToolArtifactReference[];
};

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
 * The text of a tool result. An MCP result that arrives as its serialized
 * CallToolResult shows the text of its content parts; any other text is shown
 * as it is. Files the result produced come from the call's `display`.
 */
export function readToolOutput(value: unknown, display?: ToolDisplay): ToolOutputView {
  return {
    text: typeof value === 'string' ? mcpContentText(value) : '',
    artifacts: display?.type === 'mcp' ? (display.artifacts ?? []).map(artifactReference) : [],
  };
}

function artifactReference(artifact: { name: string; path: string; kind: string }) {
  return { name: artifact.name, url: workspaceUrl(artifact.path), kind: artifact.kind };
}

function mcpContentText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const content =
      parsed && typeof parsed === 'object' ? (parsed as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) return value;
    return content
      .map((part: unknown) => {
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n\n');
  } catch {
    return value;
  }
}
