export interface ManagedRuntime {
  readonly isBusy: boolean;
  readonly lastUsed: number;
  close(): Promise<void>;
}

/** Runtime registry with mutation tombstones so sessions cannot reopen mid-fork/archive. */
export function createRuntimeRegistry<T extends ManagedRuntime>(create: (id: string) => T) {
  const runtimes = new Map<string, T>();
  const mutations = new Map<string, Promise<void>>();
  let cleanup: ReturnType<typeof setInterval> | undefined;

  function get(id: string): T {
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = create(id);
      runtimes.set(id, runtime);
      if (mutations.has(id)) void runtime.close();
    }
    return runtime;
  }

  async function close(id: string): Promise<void> {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    await runtime.close();
    if (runtimes.get(id) === runtime) runtimes.delete(id);
  }

  async function closeAll(): Promise<void> {
    if (cleanup) clearInterval(cleanup);
    cleanup = undefined;
    await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
    runtimes.clear();
  }

  async function withMutation<R>(id: string, operation: () => Promise<R>): Promise<R> {
    const previous = mutations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutations.set(id, gate);
    await previous;
    const runtime = runtimes.get(id);
    try {
      if (runtime) await runtime.close();
      return await operation();
    } finally {
      const current = runtimes.get(id);
      if (current === runtime || (current && current.isBusy === false)) runtimes.delete(id);
      if (mutations.get(id) === gate) mutations.delete(id);
      release();
    }
  }

  function startIdleCleanup(idleMs: number, intervalMs: number): void {
    if (cleanup) return;
    cleanup = setInterval(() => {
      for (const [id, runtime] of runtimes) {
        if (!runtime.isBusy && Date.now() - runtime.lastUsed > idleMs) {
          void runtime.close().finally(() => {
            if (runtimes.get(id) === runtime) runtimes.delete(id);
          });
        }
      }
    }, intervalMs);
    cleanup.unref();
  }

  return { get, close, closeAll, withMutation, startIdleCleanup };
}
