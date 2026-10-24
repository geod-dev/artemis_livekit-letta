import type { ImageMediaType } from './image-type.ts';

/** A JSON Schema object describing the input of a tool. */
export type JsonSchema = Record<string, unknown>;

/** A tool as offered to a model: name, description and input schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** Plain text content. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** Inline image content. */
export interface ImageBlock {
  type: 'image';
  mediaType: ImageMediaType;
  /** Base64 data, no `data:` prefix. */
  data: string;
}
