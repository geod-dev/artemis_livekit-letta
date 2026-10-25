import { useCallback, useEffect, useState } from 'react';

/** Keep the selected conversation in `?c=<id>` without remounting anything. */
export function useSelectedConversation() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get('c'));
    const onPop = () => setId(new URLSearchParams(window.location.search).get('c'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const select = useCallback((next: string | null) => {
    setId(next);
    const url = next ? `?c=${encodeURIComponent(next)}` : window.location.pathname;
    window.history.pushState(null, '', url);
  }, []);
  return [id, select] as const;
}
