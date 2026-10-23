/** ISO-8601 text of an epoch-ms instant, as stored in the `*_at` columns. */
export function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
