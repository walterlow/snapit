import * as React from 'react';
import { Slider as BaseSlider } from '@base-ui/react/slider';
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

    // Sync local state when external value changes (not during drag)
    React.useEffect(() => {
      if (!isDragging.current) {
        setLocalValue(value[0]);
      }
    }, [value]);

    return (
      <BaseSlider.Root
        ref={ref}
        value={localValue}
        onValueChange={(val) => {
          isDragging.current = true;
          setLocalValue(val);
          onValueChange?.([val]);
        }}
        onValueCommitted={(val) => {
          isDragging.current = false;
          onValueCommit?.([val]);
        }}
        min={min}
        max={max}
        step={step}
        className={cn('relative flex w-full touch-none select-none items-center h-5', className)}
      >
        <BaseSlider.Control className="relative flex items-center w-full h-full">
          <BaseSlider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[var(--obsidian-elevated)]">
            <BaseSlider.Indicator className="absolute h-full bg-amber-400" />
          </BaseSlider.Track>
          <BaseSlider.Thumb className="block h-4 w-4 rounded-full border border-amber-400/50 bg-amber-400 ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/30 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer" />
        </BaseSlider.Control>
      </BaseSlider.Root>
    );
  }
);
Slider.displayName = 'Slider';

export { Slider };
