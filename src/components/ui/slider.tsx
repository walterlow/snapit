import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/utils';

interface SliderProps {
  value: number[];
  onValueChange?: (value: number[]) => void;
  onValueCommit?: (value: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  ({ value, onValueChange, onValueCommit, min = 0, max = 100, step = 1, className }, ref) => {
    // Local state for smooth visual updates during drag
    const [localValue, setLocalValue] = React.useState(value[0]);
    const isDragging = React.useRef(false);
    const rafRef = React.useRef<number | null>(null);
    const pendingValueRef = React.useRef<number | null>(null);

    // Sync local state when external value changes (not during drag)
    React.useEffect(() => {
      if (!isDragging.current) {
        setLocalValue(value[0]);
      }
    }, [value]);

    // Cleanup RAF on unmount
    React.useEffect(() => {
      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
        }
      };
    }, []);

    // RAF-throttled callback for smooth preview updates
    const scheduleValueChange = React.useCallback((val: number) => {
      pendingValueRef.current = val;

      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          if (pendingValueRef.current !== null) {
            onValueChange?.([pendingValueRef.current]);
          }
        });
      }
    }, [onValueChange]);

    return (
      <SliderPrimitive.Root
        ref={ref}
        value={[localValue]}
        onValueChange={(values) => {
          isDragging.current = true;
          setLocalValue(values[0]); // Immediate local update for thumb position
          scheduleValueChange(values[0]); // RAF-throttled callback
        }}
        onValueCommit={(values) => {
          isDragging.current = false;
          // Cancel any pending RAF and call commit directly
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          onValueCommit?.(values);
        }}
        min={min}
        max={max}
        step={step}
        className={cn('relative flex w-full touch-none select-none items-center h-5', className)}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[var(--polar-mist)]">
          <SliderPrimitive.Range className="absolute h-full bg-[var(--coral-400)]" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-[var(--coral-400)] bg-white shadow-md ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-glow)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer hover:scale-110" />
      </SliderPrimitive.Root>
    );
  }
);
Slider.displayName = 'Slider';

export { Slider };
