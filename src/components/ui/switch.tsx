import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cn } from '@/lib/utils';

interface SwitchProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, className, disabled }, ref) => (
    <BaseSwitch.Root
      ref={ref}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-glow)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-[var(--coral-400)] bg-[var(--polar-steel)]',
        className
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform data-[checked]:translate-x-4 translate-x-0'
        )}
      />
    </BaseSwitch.Root>
  )
);
Switch.displayName = 'Switch';

export { Switch };
