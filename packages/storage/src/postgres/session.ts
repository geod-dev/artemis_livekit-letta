import { ConflictError, NotFoundError } from '@artemis/core';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * A query target that is either the pool (autocommit) or one checked-out client inside a transaction.
 * Repositories only see this type, so the same code runs in and out of transactions.
 */
export class PgSession {
  constructor(
    private readonly pool: Pool,
    private readonly client: PoolClient | null
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    try {
      return await (this.client ?? this.pool).query<R>(text, values);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  /** Runs `fn` in one transaction; nested calls join the transaction that is already open. */
  async transaction<T>(fn: (session: PgSession) => Promise<T>): Promise<T> {
    if (this.client !== null) return fn(this);

    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(new PgSession(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

/** Unique and foreign-key violations surface as the core error types the callers already handle. */
export function mapDatabaseError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return error;
  const { code, detail, message } = error as { code: unknown; detail?: unknown; message?: unknown };
  if (code === '23505') return new ConflictError('duplicate_key', String(detail ?? message));
  if (code === '23503') return new NotFoundError('referenced row');
  return error;
}
