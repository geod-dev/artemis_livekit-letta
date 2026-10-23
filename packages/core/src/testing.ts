import type { Clock } from './clock.ts';

/**
 * Manual clock for tests: timers fire only when `advance` moves time past them.
 * Exported as `@artemis/core/testing`; never imported by production code.
 */
export class FakeClock implements Clock {
  private current = Date.parse('2026-10-22T10:00:00.000Z');
  private readonly timers: Array<{
    at: number;
    fn: () => void;
    every: number | null;
    cancelled: boolean;
  }> = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    return this.schedule(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): { cancel(): void } {
    return this.schedule(fn, ms, ms);
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.current = due.at;
      if (due.every === null) due.cancelled = true;
      else due.at += due.every;
      due.fn();
    }
    this.current = target;
  }

  private schedule(fn: () => void, ms: number, every: number | null): { cancel(): void } {
    const timer = { at: this.current + ms, fn, every, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }
}
