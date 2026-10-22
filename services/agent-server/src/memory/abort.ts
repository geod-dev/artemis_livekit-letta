import type { Clock } from '@artemis/core';

export interface TimeoutOptions {
  clock: Clock;
  timeoutMs: number;
  /** Aborting the parent aborts the work too. */
  parent?: AbortSignal;
}

/**
 * Runs `start` under a signal that aborts after `timeoutMs` or when `parent`
 * aborts. The result rejects as soon as the signal fires, even when `start`
 * ignores it, so a slow memory store can never hold a turn.
 */
export async function runWithTimeout<T>(
  options: TimeoutOptions,
  start: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = options.clock.setTimeout(
    () => controller.abort(new Error(`timed out after ${options.timeoutMs} ms`)),
    options.timeoutMs
  );
  const onParent = () => controller.abort(options.parent?.reason);
  if (options.parent?.aborted) onParent();
  else options.parent?.addEventListener('abort', onParent, { once: true });
  try {
    return await raceAbort(start(controller.signal), controller.signal);
  } finally {
    timer.cancel();
    options.parent?.removeEventListener('abort', onParent);
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) {
      work.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
