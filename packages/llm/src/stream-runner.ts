import type { ResponseAccumulator } from './accumulator.ts';
import type { LlmError } from './provider.ts';
import type { LlmStreamEvent, StopReason } from './types.ts';

/** What a vendor adapter supplies to run one model step over its SDK stream. */
export interface ModelStepDriver<E> {
  /** Opens the vendor stream. Failures here, before any output, propagate as `LlmError`. */
  open(): AsyncIterable<E> | Promise<AsyncIterable<E>>;
  apply(event: E): void;
  /** Set once the vendor reports how the step ended. */
  stopReason(): StopReason | undefined;
  /**
   * True when the step was aborted: the signal fired, or the SDK reports an abort
   * (`error` omitted: checks the signal only, for streams that end quietly on abort).
   */
  isAbort(error?: unknown): boolean;
  toError(error: unknown): LlmError;
}

/**
 * Drives one model step: forwards canonical events as they are produced and always
 * ends with `message_end`. Abort yields `aborted` with the partial content. A failure
 * after output started ends the step with `error` (the error is on the response);
 * a failure before any output throws `LlmError`.
 */
export async function* runModelStep<E>(
  acc: ResponseAccumulator,
  driver: ModelStepDriver<E>
): AsyncIterable<LlmStreamEvent> {
  let emitted = false;
  try {
    for await (const event of await driver.open()) {
      driver.apply(event);
      for (const queued of acc.drain()) {
        emitted = true;
        yield queued;
      }
    }
    const stopReason = driver.stopReason();
    if (driver.isAbort()) {
      acc.finish('aborted');
    } else if (stopReason) {
      acc.finish(stopReason);
    } else {
      acc.finish('error', { code: 'no_response', message: 'The stream ended without a stop reason' });
    }
  } catch (error) {
    if (driver.isAbort(error)) {
      acc.finish('aborted');
    } else if (!emitted) {
      throw driver.toError(error);
    } else {
      const llmError = driver.toError(error);
      acc.finish('error', { code: llmError.code, message: llmError.message });
    }
  }
  yield* acc.drain();
}
