import { useRef, useState, useEffect, useCallback } from 'react';

// Shared IntersectionObserver for all cards - much more efficient than one per card
let sharedObserver: IntersectionObserver | null = null;
const callbacks = new Map<Element, (isVisible: boolean) => void>();

function getSharedObserver(): IntersectionObserver {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const callback = callbacks.get(entry.target);
          if (entry.isIntersecting && callback) {
            callback(true);
            // Once visible, stop observing (one-time animation)
            sharedObserver?.unobserve(entry.target);
            callbacks.delete(entry.target);
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '50px',
      }
    );
  }
  return sharedObserver;
}

/**
 * Hook that triggers animation when element enters viewport.
 * Uses a shared IntersectionObserver for all cards (much more efficient).
 */
export function useInViewAnimation() {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  const setVisibleCallback = useCallback((visible: boolean) => {
    setIsVisible(visible);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Fallback if IntersectionObserver not available
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = getSharedObserver();
    callbacks.set(element, setVisibleCallback);
    observer.observe(element);

    return () => {
      observer.unobserve(element);
      callbacks.delete(element);
    };
  }, [setVisibleCallback]);

  return { ref, isVisible };
}
