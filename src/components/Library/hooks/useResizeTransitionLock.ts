import { useEffect } from 'react';

/**
 * Disables CSS transitions during window resize for smoother performance.
 * Adds 'resizing' class to document body during resize.
 */
export function useResizeTransitionLock() {
  useEffect(() => {
    let resizeTimer: number | null = null;
    
    const handleResize = () => {
      // Add class immediately on resize start
      document.body.classList.add('resizing');
      
      // Clear any existing timer
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      
      // Remove class after resize ends (debounced)
      resizeTimer = window.setTimeout(() => {
        document.body.classList.remove('resizing');
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      document.body.classList.remove('resizing');
    };
  }, []);
}
