import { useRef, useState, useEffect } from 'react';

/**
 * Hook that triggers animation when element enters viewport.
 * Items already in view animate immediately, scrolled items animate on entry.
 */
export function useInViewAnimation(options?: {
  threshold?: number;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Check if IntersectionObserver is available
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback: just show immediately
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            // Once visible, stop observing (one-time animation)
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: options?.threshold ?? 0.1,
        rootMargin: options?.rootMargin ?? '50px', // Start animation slightly before entering viewport
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [options?.threshold, options?.rootMargin]);

  return { ref, isVisible };
}
