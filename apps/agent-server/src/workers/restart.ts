/** Stored reason of a turn or tool call that a server restart interrupted (boot recovery). */
export const RESTART_REASON = 'interrupted by restart';

/** The text a restart-interrupted tool result and the conversation's update carry. */
export const RESTART_TEXT = 'Interrupted by a server restart';

/** The failure report a task is ended with when the restart happens under it. */
export const RESTART_FAILURE = RESTART_TEXT;
