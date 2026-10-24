/**
 * Elapsed-time wording, one module for the two styles the UI shows.
 * Both take milliseconds.
 */

/** A tool call's elapsed time: "<1s", "9.5s", "12s", "1m 5s". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** A terminal run's duration: "850ms", "1.5s", "1m 05s". NaN and negatives count as zero. */
export function formatPrecise(durationMs: number): string {
  const bounded = Number.isNaN(durationMs)
    ? 0
    : Math.min(Math.max(durationMs, 0), Number.MAX_SAFE_INTEGER);
  const duration = Math.floor(bounded);
  if (duration < 1000) return `${duration}ms`;
  if (duration < 60_000) {
    const seconds = Math.round(duration / 100) / 10;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.floor((duration % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
