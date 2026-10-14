import { memo, useCallback, useRef, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Streamdown } from 'streamdown';
import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartStatus,
  useScrollLock,
  useToolCallElapsed,
} from '@assistant-ui/react';
import { code } from '@streamdown/code';
import { BashTerminal } from '@/components/assistant-ui/tools/bash-terminal';
import {
  MARKDOWN_COMPONENTS,
  MARKDOWN_REHYPE_PLUGINS,
} from '@/components/assistant-ui/markdown/markdown-text';
import {
  getToolDisplay,
  toolCall,
  toolCallLabel,
} from '@/components/assistant-ui/tools/tool-display';
import { WebSearchResults } from '@/components/assistant-ui/tools/web-search-results';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/shadcn/utils';
import { formatToolValue, readToolOutput } from '@/lib/tool-output';
import { selectToolRenderer } from '@/lib/tool-renderer';

const ANIMATION_DURATION = 200;
const TOOL_MARKDOWN_PLUGINS = { code };

function ToolDetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel text-foreground/90 min-w-0 rounded-md p-2.5 text-xs">
      <p className="text-muted-foreground mb-1.5 text-[10px] font-normal">{title}</p>
      {children}
    </div>
  );
}

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange]
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn('aui-tool-fallback-root group/tool-fallback-root w-full', className)}
      style={
        {
          '--animation-duration': `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({ className, ...props }: React.ComponentProps<'span'>) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        'aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums',
        className
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  argsText,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  argsText?: string;
  status?: ToolCallMessagePartStatus;
}) {
  const isRunning = status?.type === 'running';
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';

  const call = toolCall(toolName, argsText);
  const Icon = getToolDisplay(call).icon;

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        'aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit origin-left items-center gap-1.5 py-1 text-xs transition-[color,scale] active:scale-[0.98]',
        className
      )}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          'aui-tool-fallback-trigger-icon size-3.5 shrink-0',
          isCancelled && 'text-muted-foreground'
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          'aui-tool-fallback-trigger-label-wrapper inline-block text-start leading-none',
          isCancelled && 'text-muted-foreground line-through',
          isRunning && 'shimmer motion-reduce:animate-none'
        )}
      >
        {toolCallLabel(call)}
      </span>
      <ToolFallbackDuration />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          'aui-tool-fallback-trigger-chevron size-3.5 shrink-0',
          'transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
          '-rotate-90',
          'group-data-open/trigger:rotate-0',
          'group-data-panel-open/trigger:rotate-0'
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        'aui-tool-fallback-content relative overflow-hidden text-sm outline-none',
        'group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
        'data-closed:animate-collapsible-up',
        'data-open:animate-collapsible-down',
        'data-closed:fill-mode-forwards',
        'data-closed:pointer-events-none',
        '[--tw-duration:var(--animation-duration)]',
        className
      )}
      {...props}
    >
      <div
        className={cn(
          'flex flex-col gap-2 ps-6 pt-1 pb-2 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
          'group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1',
          'group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1',
          'group-data-closed/collapsible-content:animation-duration-(--animation-duration) group-data-open/collapsible-content:animation-duration-(--animation-duration)'
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  toolName,
  argsText,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  toolName: string;
  argsText?: string;
}) {
  const call = toolCall(toolName, argsText);
  const cards = getToolDisplay(call).cards(call);
  if (cards.length === 0) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn('aui-tool-fallback-args grid gap-2', className)}
      {...props}
    >
      {cards.map(({ title, content }, index) => (
        <ToolDetailCard key={`${index}:${title}`} title={title}>
          <pre className="aui-tool-fallback-args-value font-sans break-words whitespace-pre-wrap">
            {formatUnknownValue(content, 2)}
          </pre>
        </ToolDetailCard>
      ))}
    </div>
  );
}

const formatUnknownValue = formatToolValue;

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  result?: unknown;
}) {
  if (result === undefined) return null;
  const output = readToolOutput(result);
  if (!output.text && output.artifacts.length === 0) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn('aui-tool-fallback-result', className)}
      {...props}
    >
      <ToolDetailCard title="Result">
        {output.text && (typeof result === 'string' || output.isEnvelope) ? (
          <Streamdown
            mode="static"
            plugins={TOOL_MARKDOWN_PLUGINS}
            components={MARKDOWN_COMPONENTS}
            rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
            shikiTheme={['github-light', 'github-dark']}
            className="aui-tool-fallback-result-content space-y-2 break-words [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs"
          >
            {output.text}
          </Streamdown>
        ) : null}
        {output.artifacts.map((artifact) => (
          <a
            key={`${artifact.url}:${artifact.name}`}
            href={artifact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            {artifact.name}
          </a>
        ))}
        {!output.isEnvelope && typeof result !== 'string' ? (
          <pre className="aui-tool-fallback-result-content break-words whitespace-pre-wrap">
            {formatUnknownValue(result, 2)}
          </pre>
        ) : null}
      </ToolDetailCard>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== 'incomplete') return null;

  const error = status.error;
  const errorText = error === undefined || error === null ? null : formatUnknownValue(error);

  if (!errorText) return null;

  const isCancelled = status.reason === 'cancelled';
  const headerText = isCancelled ? 'Cancelled reason:' : 'Error:';

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn('aui-tool-fallback-error', className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground whitespace-pre-line">
        {errorText}
      </p>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  isError,
  status,
}) => {
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';
  const call = toolCall(toolName, argsText);
  const isRunning = status?.type === 'running';
  const renderer = selectToolRenderer(call, result, isRunning, isError);
  const showCards = renderer.kind === 'generic';
  const [open, setOpen] = useState(false);

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} argsText={argsText} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        {renderer.kind === 'web-search' ? (
          <WebSearchResults query={renderer.query} output={renderer.output} />
        ) : renderer.kind === 'terminal' ? (
          <BashTerminal command={renderer.command} output={renderer.output} />
        ) : (
          <ToolFallbackArgs
            toolName={toolName}
            argsText={argsText}
            className={cn(isCancelled && 'opacity-60')}
          />
        )}
        {showCards && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = 'ToolFallback';
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
