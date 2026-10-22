/** Injectable time source, so timers and reapers are testable. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
  setInterval(fn: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  },
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    return { cancel: () => clearInterval(t) };
  },
};
