// Assistant-ui ComposerContext, installed from @assistant-ui/elements-composer.
// https://www.assistant-ui.com/elements/composer-context
// Accept the aggregate usage when no category breakdown is available.
import type { ComponentProps } from 'react';
import { ghostButton, mono } from '@/components/assistant-ui/shared/surfaces';
import { clamp } from '@/components/assistant-ui/utils/range';
import { cn } from '@/lib/shadcn/utils';

const floating = 'bg-popover text-popover-foreground border border-border/60 shadow-md';
const pct = (value: number, total: number) =>
  total > 0 ? clamp((value / total) * 100, 0, 100) : 0;

/** All values are in thousands of tokens, as in the upstream element. */
interface ComposerUsage {
  system: number;
  tools: number;
  messages: number;
  total: number;
}

interface ComposerAggregateUsage {
  used: number;
  total: number;
}

export function ComposerContext({
  usage,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & { usage: ComposerUsage | ComposerAggregateUsage }) {
  const used = 'used' in usage ? usage.used : usage.system + usage.tools + usage.messages;
  const fraction = usage.total === 0 ? 0 : used / usage.total;
  const warn = fraction > 0.85;
  const circumference = 2 * Math.PI * 6;
  const segments =
    'used' in usage
      ? [{ label: 'Used', value: usage.used, className: 'bg-foreground/80' }]
      : [
          { label: 'System', value: usage.system, className: 'bg-foreground/25' },
          { label: 'Tools', value: usage.tools, className: 'bg-foreground/45' },
          { label: 'Messages', value: usage.messages, className: 'bg-foreground/80' },
        ];

  return (
    <div data-slot="composer-context" className={cn('group/ctx relative', className)} {...props}>
      <div
        className={cn(
          floating,
          'absolute end-0 bottom-full z-30 mb-2 flex w-60 origin-bottom-right flex-col gap-3.5 rounded-2xl p-4',
          'transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
          'pointer-events-none scale-[0.97] opacity-0',
          'group-hover/ctx:pointer-events-auto group-hover/ctx:scale-100 group-hover/ctx:opacity-100',
          'group-focus-within/ctx:pointer-events-auto group-focus-within/ctx:scale-100 group-focus-within/ctx:opacity-100'
        )}
      >
        <div className="flex items-baseline justify-between">
          <p className="text-[13.5px] font-medium">Context</p>
          <p
            className={cn(
              mono,
              'tabular-nums',
              warn ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'
            )}
          >
            {Math.round(fraction * 100)}%
          </p>
        </div>
        <div className="bg-foreground/[0.06] inset-ring-border flex h-[5px] w-full gap-px overflow-hidden rounded-full inset-ring forced-colors:border">
          {segments.map((segment) => (
            <span
              key={segment.label}
              className={cn(
                'h-full transition-[width] duration-700 forced-color-adjust-none motion-reduce:transition-none',
                segment.className
              )}
              style={{ width: `${pct(segment.value, usage.total)}%` }}
            />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className="text-muted-foreground flex items-center gap-2.5 text-[13px]"
            >
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full forced-color-adjust-none', segment.className)}
              />
              <span className="flex-1">{segment.label}</span>
              <span className={cn(mono, 'text-muted-foreground tabular-nums')}>
                {segment.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}k
              </span>
            </div>
          ))}
        </div>
        <div className="bg-foreground/[0.06] h-px" />
        <div className="text-muted-foreground flex items-center justify-between text-[13px]">
          <span>Total</span>
          <span className={cn(mono, 'text-muted-foreground tabular-nums')}>
            {used.toLocaleString(undefined, { maximumFractionDigits: 1 })}k /{' '}
            {usage.total.toLocaleString(undefined, { maximumFractionDigits: 1 })}k
          </span>
        </div>
        {'used' in usage && (
          <p className="text-muted-foreground text-xs">
            Last reported estimate, including system, tools, memory and conversation.
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label={`Context usage: ${Math.round(fraction * 100)}%`}
        className={cn(ghostButton, 'size-8', warn && 'text-red-500 dark:text-red-400')}
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-current transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamp(fraction, 0, 1))}
          />
        </svg>
      </button>
    </div>
  );
}
