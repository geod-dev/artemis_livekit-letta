/** Build a reminder for the next user turn without changing earlier messages. */
export function mcpToolsReminder(
  currentNames: readonly string[],
  previousNames: readonly string[] | null
): string | undefined {
  const current = [...new Set(currentNames)].sort((a, b) => a.localeCompare(b));
  const previous = previousNames === null ? null : new Set(previousNames);
  const added = previous === null ? current : current.filter((name) => !previous.has(name));
  const currentSet = new Set(current);
  const removed =
    previous === null ? [] : [...previous].filter((name) => !currentSet.has(name)).sort();
  if (!added.length && !removed.length) return undefined;

  const safeName = (name: string) =>
    JSON.stringify(name).slice(1, -1).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  const lines = ['<system-reminder>'];
  if (previous === null) lines.push('Available MCP tools:');
  else lines.push('MCP tool list changed:');
  if (added.length) {
    if (previous !== null) lines.push('Added:');
    lines.push(...added.map(safeName));
  }
  if (removed.length) {
    lines.push('Removed:');
    lines.push(...removed.map(safeName));
  }
  lines.push('</system-reminder>');
  return lines.join('\n');
}
