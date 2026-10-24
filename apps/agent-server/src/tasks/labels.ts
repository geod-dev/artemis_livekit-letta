/**
 * Label of a background update, the one wording used by both the stored history rows
 * and the live task events, so the same event row reads the same before and after a reload.
 */
export function taskUpdateLabel(update: { title: string; status: 'completed' | 'failed' | 'cancelled'; needsInput: boolean }): string {
  if (update.needsInput) return `Background task needs input: ${update.title}`;
  return `Background task ${update.status}: ${update.title}`;
}
