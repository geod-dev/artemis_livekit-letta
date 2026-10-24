import type { ComponentProps } from 'react';
import { type VariantProps, cva } from 'class-variance-authority';
import { hostOf } from '@/components/media/markdown/href';
import { cn } from '@/lib/shadcn/utils';

const sourceVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors motion-reduce:transition-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        outline:
          'border-input text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground border bg-transparent',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/80',
        muted: 'bg-muted text-muted-foreground [a&]:hover:bg-muted/80 [a&]:hover:text-foreground',
        ghost:
          'text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground bg-transparent',
        info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 [a&]:hover:bg-blue-100/80',
        warning:
          'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 [a&]:hover:bg-amber-100/80',
        success:
          'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 [a&]:hover:bg-emerald-100/80',
        destructive:
          'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 [a&]:hover:bg-red-100/80',
      },
      size: {
        sm: 'px-1.5 py-0.5',
        default: 'px-2 py-1',
        lg: 'px-2.5 py-1.5 text-sm',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  }
);

/** A letter avatar for the cited host. Favicons are not fetched: that would send the reader's browsing to a third party. */
function SourceIcon({ url, className, ...props }: ComponentProps<'span'> & { url: string }) {
  const domain = hostOf(url);
  return (
    <span
      data-slot="source-icon-fallback"
      className={cn(
        'bg-muted flex size-3 shrink-0 items-center justify-center rounded-sm text-[10px] font-medium',
        className
      )}
      {...props}
    >
      {domain?.charAt(0).toUpperCase() || '?'}
    </span>
  );
}

function SourceTitle({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span data-slot="source-title" className={cn('max-w-37.5 truncate', className)} {...props} />
  );
}

type SourceProps = ComponentProps<'a'> & VariantProps<typeof sourceVariants>;

function Source({
  className,
  variant,
  size,
  target = '_blank',
  rel = 'noopener noreferrer',
  ...props
}: SourceProps) {
  return (
    <a
      data-slot="source"
      className={cn(
        sourceVariants({ variant, size }),
        'focus-visible:border-ring focus-visible:ring-ring/50 cursor-pointer outline-none focus-visible:ring-1',
        className
      )}
      target={target}
      rel={rel}
      {...props}
    />
  );
}

export { Source, SourceIcon, SourceTitle };
