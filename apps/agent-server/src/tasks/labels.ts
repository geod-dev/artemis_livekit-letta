/**
 * Label of a background update. Two consumers use it: the stored history rows and the
 * live task events, so an event row reads the same before and after a reload. The memory
 * transcript writes its own speaker label from the title and does not use this function.
 */
export function taskUpdateLabel(update: { title: string; status: 'completed' | 'failed' | 'cancelled'; needsInput: boolean }): string {
  if (update.needsInput) return `Background task needs input: ${update.title}`;
  return `Background task ${update.status}: ${update.title}`;
}
