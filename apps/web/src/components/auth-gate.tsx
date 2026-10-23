import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { MascotMark } from '@/components/chat/mascot';
import { isRecord, requestJson, responseJson } from '@/lib/api';

export function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionRetry, setSessionRetry] = useState(0);
  const checkRevision = useRef(0);
  const authenticatedRef = useRef(false);
  authenticatedRef.current = authenticated === true;
  useEffect(() => {
    const check = () => {
      const revision = ++checkRevision.current;
      void requestJson(
        '/api/auth/session',
        {},
        (value): value is { authenticated: boolean } =>
          isRecord(value) && typeof value.authenticated === 'boolean',
        'Unable to check your session'
      )
        .then((result) => {
          if (revision !== checkRevision.current) return;
          setAuthenticated(result.authenticated);
          setError('');
        })
        .catch((e: unknown) => {
          if (revision !== checkRevision.current) return;
          const status = e && typeof e === 'object' && 'status' in e ? e.status : null;
          if (status === 401) {
            setAuthenticated(false);
            setError('');
          } else {
            // Keep an already running chat mounted during temporary outages.
            if (!authenticatedRef.current) setAuthenticated(false);
            setError('Unable to connect to the server. Check your connection and try again.');
          }
        });
    };
    void check();
    window.addEventListener('focus', check);
    return () => {
      checkRevision.current += 1;
      window.removeEventListener('focus', check);
    };
  }, [sessionRetry]);
  async function login(e: FormEvent) {
    e.preventDefault();
    checkRevision.current += 1;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await responseJson(
        response,
        (value): value is { authenticated: boolean } =>
          isRecord(value) && typeof value.authenticated === 'boolean',
        'Unable to sign in'
      );
      if (!body.authenticated) throw new Error('Sign in was not accepted.');
      setPassword('');
      setAuthenticated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }
  if (authenticated)
    return (
      <>
        {children}
        {error && (
          <div
            role="alert"
            className="surface-panel fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-2 text-sm"
          >
            <span>{error}</span>
            <button
              type="button"
              className="underline"
              onClick={() => setSessionRetry((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        )}
      </>
    );
  return (
    <main className="auth-screen flex h-dvh items-center justify-center overflow-y-auto p-4 sm:p-6">
      <form
        onSubmit={login}
        className="surface-panel auth-card my-auto w-full max-w-sm shrink-0 space-y-5 rounded-[var(--control-radius)] p-8"
      >
        <MascotMark className="auth-mark text-primary size-14" aria-hidden="true" />
        <h1 className="auth-title">Hello again.</h1>
        {authenticated === null ? (
          <p role="status" className="text-muted-foreground">
            Finding your space…
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {import.meta.env.ASSISTANT_NAME} is right here. Enter your password to begin.
            </p>
            <input
              aria-label="Password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="focus-visible:outline-primary w-full rounded-lg border px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <button
              disabled={busy}
              className="bg-primary text-primary-foreground w-full rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
