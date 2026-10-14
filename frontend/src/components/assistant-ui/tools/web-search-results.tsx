import { SearchIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/shadcn/utils';
import type { WebResult, WebSearchOutput } from '@/lib/web-search';
import { hostOf, safeHref } from '../utils/href';
import { SourceIcon } from '@/components/assistant-ui/markdown/sources';
import { ShimmerLabel, mono, paper } from '@/components/assistant-ui/shared/surfaces';

/**
 * A web search as a small browser window: the query in its address bar, the
 * results as a search page. `output` is null while the search runs.
 */
export function WebSearchResults({
  query,
  output,
}: {
  query: string;
  output: WebSearchOutput | null;
}) {
  const count = output?.results.length ?? 0;
  return (
    <div
      data-slot="web-search"
      className={cn(paper, 'mb-1 flex flex-col overflow-hidden rounded-2xl shadow-xs')}
    >
      <div className="bg-foreground/[0.03] border-border/60 flex items-center gap-3 border-b px-3 py-2">
        <div aria-hidden className="flex shrink-0 gap-1.5">
          <span className="size-2.5 rounded-full bg-red-400/80" />
          <span className="size-2.5 rounded-full bg-amber-400/80" />
          <span className="size-2.5 rounded-full bg-emerald-400/80" />
        </div>
        <div className="bg-background border-border/60 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 text-xs">
          <SearchIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <SearchQuery query={query} searching={!output} />
        </div>
        {output && (
          <span className={cn(mono, 'text-foreground/40 shrink-0')}>
            {count} {count === 1 ? 'result' : 'results'}
          </span>
        )}
      </div>
      <div className="max-h-[26rem] overflow-y-auto px-4 py-3.5">
        {output ? (
          <ol className="flex flex-col gap-4">
            {output.results.map((result, index) => (
              <WebSearchResult key={`${index}:${result.url}`} result={result} />
            ))}
          </ol>
        ) : (
          <div aria-hidden className="flex flex-col gap-4">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        )}
        {output?.truncated && (
          <p className={cn(mono, 'text-foreground/35 mt-4')}>
            The output was cut short: other results are not shown.
          </p>
        )}
      </div>
    </div>
  );
}

/** The query in the address bar; long queries are clipped to fit. */
function SearchQuery({ query, searching }: { query: string; searching: boolean }) {
  return (
    <ShimmerLabel
      active={searching}
      aria-label={query || 'Searching the web'}
      className="text-foreground min-w-0 flex-1 truncate"
    >
      {query || 'Searching the web'}
    </ShimmerLabel>
  );
}

function WebSearchResult({ result }: { result: WebResult }) {
  const href = safeHref(result.url);
  const host = hostOf(result.url) ?? result.url;
  const date = formatDate(result.published);
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        <SourceIcon url={result.url} className="size-4" />
        <span className="truncate">{host}</span>
        {date && <span className="shrink-0">· {date}</span>}
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 w-fit text-[15px] leading-snug font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
        >
          {result.title}
        </a>
      ) : (
        <span className="line-clamp-2 text-[15px] leading-snug font-medium">{result.title}</span>
      )}
      {result.snippet && (
        <p className="text-muted-foreground line-clamp-2 text-[13px] leading-relaxed">
          {result.snippet}
        </p>
      )}
    </li>
  );
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
