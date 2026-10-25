/** Shown when the session check cannot reach the server. */
export const SESSION_UNREACHABLE =
  'Unable to connect to the server. Check your connection and try again.';

type SessionFailure = {
  /** The gate shows the sign-in form. */
  signOut: boolean;
  error: string;
};

/**
 * What a failed session check changes. A 401 signs out with no message. Any other
 * failure shows the connection error, and a running chat stays mounted through a
 * temporary outage.
 */
export function sessionCheckFailure(error: unknown, authenticated: boolean): SessionFailure {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
  if (status === 401) return { signOut: true, error: '' };
  return { signOut: !authenticated, error: SESSION_UNREACHABLE };
}
