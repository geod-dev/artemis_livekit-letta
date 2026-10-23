import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/shadcn/utils';

const SIDEBAR_ITEM_CLASS =
  'sidebar-item flex min-h-10 w-full items-center gap-2 rounded-[var(--control-radius)] px-3 py-2 text-start text-[13.5px] font-medium text-muted-foreground outline-none transition-[color,background-color] duration-150 hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[active=true]:bg-foreground/[0.07] data-[active=true]:text-foreground';

type SidebarItemProps = ComponentPropsWithoutRef<'button'> & { asChild?: boolean };

export const SidebarItem = forwardRef<ElementRef<'button'>, SidebarItemProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const Component = asChild ? Slot.Root : 'button';
    return (
      <Component
        ref={ref}
        data-sidebar-item=""
        className={cn(SIDEBAR_ITEM_CLASS, className)}
        {...props}
      />
    );
  }
);

SidebarItem.displayName = 'SidebarItem';
