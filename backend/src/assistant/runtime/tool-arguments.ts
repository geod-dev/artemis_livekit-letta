/** Reassemble streamed native tool arguments, or use the parsed complete input. */
export function mergeToolArguments(
  previous: string,
  message: { toolInput: Record<string, unknown>; rawArguments?: string }
): string {
  if (message.rawArguments !== undefined) return previous + message.rawArguments;
  const input = message.toolInput;
  if (typeof input.raw === 'string') return previous + input.raw;
  return Object.keys(input).length ? JSON.stringify(input) : previous;
}
