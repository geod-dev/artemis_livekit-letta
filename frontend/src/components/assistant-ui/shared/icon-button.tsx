import { type ComponentPropsWithRef, forwardRef } from 'react';
import { Slot } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shadcn/utils';

export type IconButtonProps = ComponentPropsWithRef<typeof Button> & { label: string };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ children, label, 'aria-label': ariaLabel = label, className, ...rest }, ref) => (
    <Button
      variant="ghost"
      size="icon"
      aria-label={ariaLabel}
      {...rest}
      className={cn('aui-button-icon size-6 p-1 active:scale-90', className)}
      ref={ref}
    >
      <Slot.Slottable>{children}</Slot.Slottable>
    </Button>
  )
);

IconButton.displayName = 'IconButton';
