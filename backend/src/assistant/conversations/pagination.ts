import { HttpError } from '../../http';

export class ProviderPaginationError extends HttpError {
  constructor(resource: string, reason: 'cursor' | 'limit') {
    super(`Could not fully read ${resource} because provider pagination ${reason} was invalid`, 503);
    this.name = 'ProviderPaginationError';
  }
}

/** Collect a complete provider listing or fail without returning partial data. */
export async function collectProviderPages<T>(options: {
  resource: string;
  pageSize: number;
  maxPages: number;
  initialCursor?: string;
  fetchPage: (cursor?: string) => Promise<readonly T[]>;
  cursorFor: (page: readonly T[]) => string | undefined;
}): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor = options.initialCursor;
  if (cursor) seen.add(cursor);
  for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber += 1) {
    const page = await options.fetchPage(cursor);
    items.push(...page);
    if (page.length < options.pageSize) return items;
    const next = options.cursorFor(page);
    if (!next || seen.has(next)) throw new ProviderPaginationError(options.resource, 'cursor');
    seen.add(next);
    cursor = next;
  }
  throw new ProviderPaginationError(options.resource, 'limit');
}
