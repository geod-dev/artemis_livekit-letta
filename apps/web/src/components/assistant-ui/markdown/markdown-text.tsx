import {
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  memo,
  useEffect,
  useState,
} from 'react';
import { Globe2Icon } from 'lucide-react';
import {
  type DiagramPlugin,
  type MermaidErrorComponentProps,
  Streamdown,
  defaultComponents,
  defaultRehypePlugins,
  useIsCodeFenceIncomplete,
} from 'streamdown';
import {
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
} from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';
import { workspacePath } from '@/lib/attachments';
import { rehypeCitations } from '@/lib/citations';
import { cn } from '@/lib/shadcn/utils';
import { TtlLruCache } from '@/lib/ttl-lru-cache';
import { hostOf, safeHref } from '../utils/href';
import { LinkPreview } from '@/components/assistant-ui/markdown/link-preview';
import { Source, SourceIcon, SourceTitle } from '@/components/assistant-ui/markdown/sources';
import { WorkspaceFileCard, WorkspaceImage } from '@/components/assistant-ui/files/workspace-file';

/**
 * Streamdown's Mermaid plugin, loaded with the first diagram: it bundles the
 * mermaid library, which would otherwise weigh on every page load. Streamdown
 * only asks the plugin for `getMermaid(config).render(id, source)`.
 */
const loadMermaid = () => import('@streamdown/mermaid').then((module) => module.mermaid);
type MermaidConfig = Parameters<Awaited<ReturnType<typeof loadMermaid>>['getMermaid']>[0];
const appMermaidConfig = (config?: MermaidConfig): MermaidConfig => ({
  ...config,
  theme: document.documentElement.classList.contains('dark') ? 'dark' : config?.theme,
});
const mermaid: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid: (config) => ({
    initialize: (next) => {
      void loadMermaid().then((plugin) =>
        plugin.getMermaid(appMermaidConfig(next as MermaidConfig))
      );
    },
    render: async (id, source) =>
      (await loadMermaid()).getMermaid(appMermaidConfig(config as MermaidConfig)).render(id, source),
  }),
};

/** Shiki code highlighting; ```mermaid blocks drawn as diagrams (redrawn as they stream). */
const PLUGINS = { code, mermaid };

/**
 * A diagram that does not parse: while its fence is still streaming it is just
 * not drawable yet; once complete, the error and the source are shown.
 */
function MermaidError({ chart, error }: MermaidErrorComponentProps) {
  const streaming = useIsCodeFenceIncomplete();
  if (streaming) {
    return (
      <p className="text-muted-foreground shimmer my-4 text-sm motion-reduce:animate-none">
        Drawing diagram…
      </p>
    );
  }
  return (
    <div className="surface-panel my-4 rounded-md">
      <pre className="overflow-x-auto p-4 font-mono text-xs">{chart.trim()}</pre>
      <p className="text-muted-foreground border-border border-t px-4 py-1.5 text-xs">
        Diagram could not be drawn: {error}
      </p>
    </div>
  );
}

const MERMAID = { errorComponent: MermaidError };
const SHIKI_THEME: ['github-light', 'github-dark'] = ['github-light', 'github-dark'];

/**
 * Streamdown's rehype plugins, with links resolved against the app's origin:
 * without an origin, its link hardening blocks relative links, which is how the
 * assistant links workspace files. Citations are marked last, on the final links.
 */
type Pluggable = (typeof defaultRehypePlugins)[string];
type Plugin = Extract<Pluggable, (...args: never[]) => unknown>;
const [harden, hardenOptions] = defaultRehypePlugins.harden as [Plugin, object];
export const MARKDOWN_REHYPE_PLUGINS: Pluggable[] = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [harden, { ...hardenOptions, defaultOrigin: window.location.origin }],
  rehypeCitations,
];

type PreviewMetadata = { title?: string; description?: string };
const METADATA_CACHE_LIMIT = 64;
const METADATA_CACHE_TTL_MS = 10 * 60_000;
const METADATA_IN_FLIGHT_LIMIT = 32;
const metadataCache = new TtlLruCache<string, PreviewMetadata>(
  METADATA_CACHE_LIMIT,
  METADATA_CACHE_TTL_MS
);
const metadataRequests = new Map<string, Promise<PreviewMetadata | undefined>>();

/** A web page's title and description (fetched once per page, then shared). */
function useLinkMetadata(href: string | undefined): PreviewMetadata | undefined {
  const [metadata, setMetadata] = useState<PreviewMetadata & { href: string }>();
  useEffect(() => {
    if (!href) return;
    let active = true;
    const cached = metadataCache.get(href);
    if (cached) {
      setMetadata({ href, ...cached });
      return () => {
        active = false;
      };
    }
    let pending = metadataRequests.get(href);
    if (!pending) {
      pending = fetch(`/api/link-preview?url=${encodeURIComponent(href)}`)
        .then(async (response) => {
          if (!response.ok) return undefined;
          const result: { title?: unknown; description?: unknown } = await response.json();
          const metadata = {
            title: typeof result.title === 'string' ? result.title : undefined,
            description: typeof result.description === 'string' ? result.description : undefined,
          };
          return metadata.title || metadata.description ? metadata : undefined;
        })
        .catch(() => undefined);
      if (metadataRequests.size >= METADATA_IN_FLIGHT_LIMIT) {
        const oldest = metadataRequests.keys().next().value;
        if (oldest !== undefined) metadataRequests.delete(oldest);
      }
      metadataRequests.set(href, pending);
      void pending.then((result) => {
        if (metadataRequests.get(href) !== pending) return;
        metadataRequests.delete(href);
        if (result) metadataCache.set(href, result);
      });
    }
    void pending.then((result) => {
      if (active && result) setMetadata({ href, ...result });
    });
    return () => {
      active = false;
    };
  }, [href]);
  return metadata?.href === href ? metadata : undefined;
}

function SiteFavicon({ className }: { href: string; className?: string }) {
  return <Globe2Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />;
}

/** The text of a link's label, when it is plain text. */
const labelText = (children: ReactNode) =>
  typeof children === 'string' || typeof children === 'number' ? String(children) : undefined;

/** A cited source as a badge: the site's icon and the title the assistant gave it. */
function SourceBadge({ href, children }: { href: string; children: ReactNode }) {
  const title = labelText(children)?.trim() || hostOf(href) || href;
  return (
    <Source
      href={href}
      size="sm"
      className="mx-0.5 max-w-full align-middle no-underline"
    >
      <SourceIcon url={href} />
      <SourceTitle className="max-w-64">{title}</SourceTitle>
    </Source>
  );
}

/**
 * A link: a cited source (see `lib/citations`) as a badge, a file of the
 * agent's workspace (linked by its workspace path) as a card, anything else as
 * a link with its site icon.
 */
function MarkdownLink({ href, children, className, ...props }: ComponentProps<'a'>) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const isWebLink =
    typeof href === 'string' && /^https?:\/\//i.test(href) && safeHref(href) !== null;
  const metadata = useLinkMetadata(previewOpen && isWebLink ? href : undefined);
  const path = workspacePath(href);
  if (path) return <WorkspaceFileCard path={path} />;
  const safe = safeHref(href);
  const cited = (props as Record<string, unknown>)['data-citation'] !== undefined;
  if (cited && safe) return <SourceBadge href={safe}>{children}</SourceBadge>;
  let favicon: string | undefined;
  if (previewOpen && isWebLink && href) {
    try {
      favicon = new URL('/favicon.ico', href).href;
    } catch {}
  }
  return (
    <span
      className="inline-flex max-w-full flex-col align-baseline"
      onMouseEnter={() => isWebLink && setPreviewOpen(true)}
      onMouseLeave={() => setPreviewOpen(false)}
      onFocus={() => isWebLink && setPreviewOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setPreviewOpen(false);
      }}
    >
      <a
        {...props}
        href={href}
        target={props.target ?? '_blank'}
        rel={props.rel ?? 'noreferrer'}
        className={cn(
          'inline-flex max-w-full items-baseline gap-1 underline underline-offset-2',
          className
        )}
      >
        {href && <SiteFavicon href={href} className="translate-y-0.5" />}
        <span className="min-w-0 break-all">{children}</span>
      </a>
      {previewOpen && isWebLink && safe ? (
        <LinkPreview
          href={safe}
          title={metadata?.title || labelText(children)}
          siteName={hostOf(safe)}
          description={metadata?.description}
          favicon={favicon}
          layout="compact"
          className="mt-1 w-60 max-w-[min(15rem,80vw)]"
        />
      ) : null}
    </span>
  );
}

/** An image, or an image of the agent's workspace (embedded by its workspace path). */
function MarkdownImage(props: ComponentProps<typeof defaultComponents.img>) {
  const path = typeof props.src === 'string' ? workspacePath(props.src) : null;
  if (path) return <WorkspaceImage path={path} alt={props.alt} />;
  return <defaultComponents.img {...props} />;
}

/** Keep Markdown tables in the message flow instead of Streamdown's table card. */
function MarkdownTable({ className, ...props }: ComponentProps<'table'>) {
  return (
    <table
      {...props}
      className={cn(className, 'my-3 w-full border-collapse text-left text-sm')}
    />
  );
}

function MarkdownTableHead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead {...props} className={cn(className, 'bg-transparent')} />;
}

/** Message markdown elements: plain tables, cited sources as badges, workspace files as cards. */
export const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
  table: MarkdownTable,
  thead: MarkdownTableHead,
} as StreamdownTextComponents;

/** Link previews come from rendered markdown anchors and load only on hover or focus. */
export function MessageLinkPreviews() {
  return null;
}

/** Open Streamdown's interactive viewer when a feed diagram preview is clicked. */
function openMermaidFullscreen(event: ReactMouseEvent<HTMLDivElement>) {
  const target = event.target;
  if (!(target instanceof Element) || target.closest('[data-streamdown="mermaid-block-actions"]'))
    return;

  const diagram = target.closest('[data-streamdown="mermaid"]');
  if (!diagram) return;

  diagram
    .closest('[data-streamdown="mermaid-block"]')
    ?.querySelector<HTMLButtonElement>(
      '[data-streamdown="mermaid-block-actions"] button[title="View fullscreen"]'
    )
    ?.click();
}

function keepMermaidPreviewStatic(event: ReactWheelEvent<HTMLDivElement>) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('[data-streamdown="mermaid"]')) return;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Markdown for message text parts, rendered by Streamdown: streaming-aware
 * parsing, Shiki-highlighted code blocks (with copy/download controls), Mermaid
 * diagrams, tables and GFM. Shiki follows the app theme with a light/dark pair.
 */
export const MarkdownText = memo(function MarkdownText() {
  return (
    <div
      className="markdown-mermaid-feed contents"
      onClick={openMermaidFullscreen}
      onWheelCapture={keepMermaidPreviewStatic}
    >
      <StreamdownTextPrimitive
        plugins={PLUGINS}
        components={MARKDOWN_COMPONENTS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        shikiTheme={SHIKI_THEME}
        mermaid={MERMAID}
        controls={{ table: false }}
        containerClassName="aui-md"
        defer
      />
    </div>
  );
});

/** A whole markdown document (a workspace file), rendered like message text. */
export function MarkdownDocument({ text, className }: { text: string; className?: string }) {
  return (
    <Streamdown
      mode="static"
      plugins={PLUGINS}
      components={MARKDOWN_COMPONENTS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      shikiTheme={SHIKI_THEME}
      mermaid={MERMAID}
      className={cn('aui-md', className)}
    >
      {text}
    </Streamdown>
  );
}
