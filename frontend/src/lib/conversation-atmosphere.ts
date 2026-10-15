export type ConversationAtmosphereState = 'idle' | 'thinking' | 'tools' | 'speaking';

type Part = {
  type: string;
  text?: string;
  result?: unknown;
  isError?: boolean;
  isPreliminary?: boolean;
};

/** Completed tools and streamed prose must never keep the thinking light running. */
export function turnAtmosphere(
  running: boolean,
  parts: readonly Part[]
): ConversationAtmosphereState {
  if (!running) return 'idle';
  if (
    parts.some(
      (part) =>
        part.type === 'tool-call' &&
        !part.isError &&
        (part.result === undefined || part.isPreliminary)
    )
  )
    return 'tools';
  if (
    parts.at(-1)?.type === 'reasoning' ||
    !parts.some((part) => part.type === 'text' && part.text?.trim())
  )
    return 'thinking';
  return 'idle';
}
