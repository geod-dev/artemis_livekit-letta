import type { ComponentProps } from 'react';
import { cn } from '@/lib/shadcn/utils';

export const paper = 'surface-panel';

export const field = 'bg-foreground/[0.04] dark:bg-foreground/[0.06]';

export const ghostButton =
  'flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]';

export const inkButton =
  'bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none';

export const live = 'text-primary';

export const mono = 'font-mono text-[11px] tracking-tight';

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<'span'> & { active?: boolean }) {
  return (
    <span className={cn(active && 'shimmer motion-reduce:animate-none', className)} {...props} />
  );
}
