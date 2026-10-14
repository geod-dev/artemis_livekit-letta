import type { ComponentProps } from 'react';
import { cn } from '@/lib/shadcn/utils';
import { mono } from '@/components/assistant-ui/shared/surfaces';

/** The rule, label, rule line that opens a new day. */
export function DayHeader({
  day,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & { day: string }) {
  return (
    <div
      data-slot="day-header"
      className={cn('flex items-center gap-2.5 py-1', className)}
      {...props}
    >
      <span className="bg-foreground/[0.08] h-px flex-1" />
      <span className={cn(mono, 'text-foreground/30')}>{day}</span>
      <span className="bg-foreground/[0.08] h-px flex-1" />
    </div>
  );
}
