import * as React from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}

const Select: React.FC<SelectProps> = ({ value, onValueChange, children }) => (
  <BaseSelect.Root
    value={value}
    onValueChange={(val) => {
      if (val !== null && onValueChange) {
        onValueChange(val);
      }
    }}
  >
    {children}
  </BaseSelect.Root>
);

const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Trigger
    ref={ref}
    className={cn(
      'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-lg border border-[var(--polar-frost)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--ink-black)] ring-offset-background placeholder:text-[var(--ink-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--coral-400)]/30 focus:border-[var(--coral-400)] disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 transition-colors',
      className
    )}
    {...props}
  >
    {children}
    <BaseSelect.Icon>
      <ChevronDown className="h-4 w-4 text-[var(--ink-muted)]" />
    </BaseSelect.Icon>
  </BaseSelect.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

const SelectValue = BaseSelect.Value;

const SelectContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Positioner> & { className?: string }
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Portal>
    <BaseSelect.Positioner ref={ref} sideOffset={4} className="z-[200]" {...props}>
      <BaseSelect.Popup
        className={cn(
          'max-h-96 min-w-[8rem] overflow-hidden rounded-xl border border-[var(--polar-frost)] bg-[var(--card)] text-[var(--ink-black)] shadow-lg p-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className
        )}
      >
        {children}
      </BaseSelect.Popup>
    </BaseSelect.Positioner>
  </BaseSelect.Portal>
));
SelectContent.displayName = 'SelectContent';

interface SelectItemProps extends React.ComponentPropsWithoutRef<typeof BaseSelect.Item> {
  value: string;
  children: React.ReactNode;
  className?: string;
}

const SelectItem = React.forwardRef<HTMLDivElement, SelectItemProps>(
  ({ className, children, ...props }, ref) => (
    <BaseSelect.Item
      ref={ref}
      className={cn(
        'relative flex w-full cursor-default select-none items-center rounded-lg py-1.5 pl-2 pr-8 text-sm outline-none data-[highlighted]:bg-[var(--polar-ice)] data-[highlighted]:text-[var(--ink-black)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 transition-colors',
        className
      )}
      {...props}
    >
      <BaseSelect.ItemIndicator className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <Check className="h-4 w-4 text-[var(--coral-400)]" />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  )
);
SelectItem.displayName = 'SelectItem';

export {
  Select,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
};
