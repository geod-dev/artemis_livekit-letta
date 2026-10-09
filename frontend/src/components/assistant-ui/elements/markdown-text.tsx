import { type ComponentProps, type ReactNode, memo, useEffect, useMemo, useState } from 'react';
import { Globe2Icon } from 'lucide-react';
import {
  type DiagramPlugin,
  type MermaidErrorComponentProps,
  Streamdown,
  defaultComponents,
  defaultRehypePlugins,
  useIsCodeFenceIncomplete,
} from 'streamdown';
import { useAuiState } from '@assistant-ui/react';
import {
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
} from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';
import { workspacePath } from '@/lib/attachments';
import { rehypeCitations, withoutCitations } from '@/lib/citations';
import { cn } from '@/lib/shadcn/utils';
import { hostOf, safeHref } from '../utils/href';
import { LinkPreview } from './link-preview';
import { Source, SourceIcon, SourceTitle } from './sources.aui';
import { WorkspaceFileCard, WorkspaceImage } from './workspace-file';

/**
 * Streamdown's Mermaid plugin, loaded with the first diagram: it bundles the
 * mermaid library, which would otherwise weigh on every page load. Streamdown
 * only asks the plugin for `getMermaid(config).render(id, source)`.
 */
const loadMermaid = () => import('@streamdown/mermaid').then((module) => module.mermaid);
type MermaidConfig = Parameters<Awaited<ReturnType<typeof loadMermaid>>['getMermaid']>[0];
const mermaid: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid: (config) => ({
    initialize: (next) => {
      void loadMermaid().then((plugin) => plugin.getMermaid(next as MermaidConfig));
    },
    render: async (id, source) =>
      (await loadMermaid()).getMermaid(config as MermaidConfig).render(id, source),
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
    <div className="bg-muted/75 my-4 rounded-md">
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

const metadataRequests = new Map<string, Promise<PreviewMetadata>>();

/** A web page's title and description (fetched once per page, then shared). */
function useLinkMetadata(href: string | undefined): PreviewMetadata | undefined {
  const [metadata, setMetadata] = useState<PreviewMetadata & { href: string }>();
  useEffect(() => {
    if (!href) return;
    let active = true;
    let pending = metadataRequests.get(href);
    if (!pending) {
      pending = fetch(`/api/link-preview?url=${encodeURIComponent(href)}`)
        .then(async (response) => {
          if (!response.ok) return {};
          const result: { title?: unknown; description?: unknown } = await response.json();
          return {
            title: typeof result.title === 'string' ? result.title : undefined,
            description: typeof result.description === 'string' ? result.description : undefined,
          };
        })
        .catch(() => ({}));
      if (metadataRequests.size >= 256) {
        const oldest = metadataRequests.keys().next().value;
        if (oldest) metadataRequests.delete(oldest);
      }
      metadataRequests.set(href, pending);
    }
    void pending.then((result) => {
      if (active) setMetadata({ href, ...result });
    });
    return () => {
      active = false;
    };
  }, [href]);
  return metadata?.href === href ? metadata : undefined;
}

function SiteFavicon({ href, className }: { href: string; className?: string }) {
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  let icon: string | null = null;
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      icon = fallback
        ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=32`
        : new URL('/favicon.ico', url).href;
    }
  } catch {
    icon = null;
  }
  if (!icon || failed)
    return <Globe2Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />;
  return (
    // Site icons are best-effort decoration; the link remains useful if both sources fail.
    <img
      src={icon}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      className={cn('size-3.5 shrink-0 object-contain', className)}
      onError={() => (fallback ? setFailed(true) : setFallback(true))}
    />
  );
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
      title={href}
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
  const path = workspacePath(href);
  if (path) return <WorkspaceFileCard path={path} />;
  const safe = safeHref(href);
  const cited = (props as Record<string, unknown>)['data-citation'] !== undefined;
  if (cited && safe) return <SourceBadge href={safe}>{children}</SourceBadge>;
  return (
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
  );
}

/** An image, or an image of the agent's workspace (embedded by its workspace path). */
function MarkdownImage(props: ComponentProps<typeof defaultComponents.img>) {
  const path = typeof props.src === 'string' ? workspacePath(props.src) : null;
  if (path) return <WorkspaceImage path={path} alt={props.alt} />;
  return <defaultComponents.img {...props} />;
}

/** Message markdown elements: cited sources as badges, workspace files as cards. */
export const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
} as StreamdownTextComponents;

type MessageLink = { href: string; label: string; host: string };
function ResolvedLinkPreview({ href, label, host }: MessageLink) {
  const metadata = useLinkMetadata(href);
  return (
    <LinkPreview
      href={href}
      title={metadata?.title || label}
      siteName={host}
      description={metadata?.description}
      favicon={new URL('/favicon.ico', href).href}
      layout="compact"
      className="w-60 shrink-0"
    />
  );
}

function linksInMessage(content: readonly { type: string; text?: string }[]): MessageLink[] {
  const found = new Map<string, string>();
  for (const part of content) {
    if (part.type !== 'text' || !part.text) continue;
    // Cited sources show as badges in the text, without a card.
    const text = withoutCitations(part.text);
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
      found.set(match[2], match[1]);
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const href = match[0].replace(/[.,!?;:]+$/, '');
      if (!found.has(href)) found.set(href, href);
    }
  }
  return [...found].flatMap(([href, label]) => {
    try {
      const url = new URL(href);
      return [
        {
          href,
          label,
          host: url.hostname.replace(/^www\./, ''),
        },
      ];
    } catch {
      return [];
    }
  });
}

export function MessageLinkPreviews() {
  const content = useAuiState((s) => s.message.content);
  const previews = useMemo(() => linksInMessage(content), [content]);
  if (previews.length === 0) return null;
  return (
    <div
      aria-label="Links in this message"
      data-mascot-previews=""
      className="mt-2 flex max-w-full gap-2 overflow-x-auto px-2 pb-1"
    >
      {previews.map((preview) => (
        <ResolvedLinkPreview key={preview.href} {...preview} />
      ))}
    </div>
  );
}

/**
 * Markdown for message text parts, rendered by Streamdown: streaming-aware
 * parsing, Shiki-highlighted code blocks (with copy/download controls), Mermaid
 * diagrams, tables and GFM. Shiki follows the app theme with a light/dark pair.
 */
export const MarkdownText = memo(function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      plugins={PLUGINS}
      components={MARKDOWN_COMPONENTS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      shikiTheme={SHIKI_THEME}
      mermaid={MERMAID}
      containerClassName="aui-md"
      defer
    />
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
