import { pathToFileURL } from 'node:url';

/**
 * Runs `run` when the calling module is the process entry point (`node src/x.ts`), so that
 * importing the module (tests, other entry points) never starts it. `onError` gets its failure.
 */
export function runAsEntry(moduleUrl: string, run: () => Promise<unknown>, onError: (error: unknown) => void): void {
  if (process.argv[1] === undefined || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  void (async () => run())().catch(onError);
}
