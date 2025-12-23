import { useEffect, useRef, RefObject } from 'react';

interface MomentumScrollOptions {
  /** Scroll speed multiplier (default: 1.0) */
  multiplier?: number;
  /** Friction/decay factor 0-1, lower = more momentum (default: 0.85) */
  friction?: number;
  /** Minimum velocity to stop animation (default: 0.5) */
  minVelocity?: number;
  /** Disable momentum scroll (e.g., during marquee selection) */
  disabled?: boolean;
}

/**
 * Adds momentum/inertia scrolling to a container.
 * Gives a smooth, macOS-like scroll feel with acceleration and glide.
 */
export function useMomentumScroll(
  containerRef: RefObject<HTMLElement | null>,
  options: MomentumScrollOptions = {}
) {
  const { multiplier = 1.0, friction = 0.92, minVelocity = 0.5, disabled = false } = options;
  
  const velocityRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const animate = (time: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      
      const delta = time - lastTimeRef.current;
      lastTimeRef.current = time;

      if (Math.abs(velocityRef.current) > minVelocity) {
        container.scrollTop += velocityRef.current * (delta / 16); // Normalize to ~60fps
        velocityRef.current *= friction;
        rafRef.current = requestAnimationFrame(animate);
      } else {
        velocityRef.current = 0;
        rafRef.current = null;
      }
    };

    const handleWheel = (e: WheelEvent) => {
      // Don't interfere with horizontal scroll, pinch zoom, or when disabled
      if (disabled || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      e.preventDefault();

      // Add to velocity (allows scroll acceleration when scrolling fast)
      const scrollDelta = e.deltaY * multiplier;
      velocityRef.current += scrollDelta * 0.2;

      // Cap velocity to prevent crazy fast scrolling
      const maxVelocity = 40;
      velocityRef.current = Math.max(-maxVelocity, Math.min(maxVelocity, velocityRef.current));

      // Start animation if not already running
      if (!rafRef.current) {
        lastTimeRef.current = 0;
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [containerRef, multiplier, friction, minVelocity, disabled]);
}
