/**
 * The app's sign-out signal. A gateway request answered with 401 (outside the
 * auth routes) means the session has ended: `apiFetch` announces it and the
 * auth gate shows the sign-in form.
 */
const sessionEvents = new EventTarget();
const SESSION_ENDED = 'session-ended';

/** Tell the app that the session has ended. */
export function announceSessionEnded(): void {
  sessionEvents.dispatchEvent(new Event(SESSION_ENDED));
}

/** Call `listener` when the session ends. Returns the function that stops listening. */
export function onSessionEnded(listener: () => void): () => void {
  sessionEvents.addEventListener(SESSION_ENDED, listener);
  return () => sessionEvents.removeEventListener(SESSION_ENDED, listener);
}
