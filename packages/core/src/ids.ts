import { randomUUID } from 'node:crypto';

/** Opaque id with a readable prefix, e.g. `task_3f2b8c1a...`. Prefixes: task, turn, upd, call. */
export function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function uuid(): string {
  return randomUUID();
}
