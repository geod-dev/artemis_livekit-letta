import type { Logger } from '@artemis/core';
import { errorMessage } from '@artemis/core';

/** Runs a side effect whose failure must never fail the caller (memory, titles, delivery notices). */
export async function safely(logger: Logger, what: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    logger.error(`${what} failed`, { error: errorMessage(error) });
  }
}
