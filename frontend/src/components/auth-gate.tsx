import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

export function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = () =>
      fetch('/api/auth/session')
        .then((r) => r.json())
        .then((r) => setAuthenticated(r.authenticated === true))
        .catch(() => {
          setError('Connexion au serveur impossible.');
          setAuthenticated(false);
        });
    void check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setPassword('');
      setAuthenticated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connexion impossible.');
    } finally {
      setBusy(false);
    }
  }
  if (authenticated) return children;
  return (
    <main className="bg-background flex min-h-dvh items-center justify-center p-6">
      <form
        onSubmit={login}
        className="bg-card w-full max-w-sm space-y-5 rounded-2xl border p-8 shadow-sm"
      >
        <h1 className="text-2xl font-semibold">{import.meta.env.ASSISTANT_NAME}</h1>
        {authenticated === null ? (
          <p>Connexion…</p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Entrez votre mot de passe pour accéder à votre assistant.
            </p>
            <input
              aria-label="Mot de passe"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border px-3 py-2"
            />
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <button
              disabled={busy}
              className="bg-primary text-primary-foreground w-full rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {busy ? 'Connexion…' : 'Se connecter'}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
