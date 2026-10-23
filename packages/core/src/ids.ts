import { randomUUID } from 'node:crypto';

/**
 * Opaque id with a readable prefix, e.g. `task_3f2b8c1a...`. Prefixes name the
 * entity: task, call, conv, turn, dlv (delivery), mem (memory), proc (process).
 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function uuid(): string {
  return randomUUID();
}
