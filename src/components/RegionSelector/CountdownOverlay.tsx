/**
 * CountdownOverlay - Full-screen countdown display before recording starts.
 * 
 * Shows a large animated countdown (3-2-1) in the center of the selected region
 * before recording begins.
 */

import React, { useEffect, useState, useCallback } from 'react';

interface CountdownOverlayProps {
  /** Initial countdown value (default: 3) */
  initialCount?: number;
  /** Called when countdown reaches 0 */
  onComplete: () => void;
  /** Called if countdown is cancelled */
  onCancel?: () => void;
  /** Position to center the countdown (screen coordinates) */
  centerX?: number;
  centerY?: number;
  /** Whether the countdown is visible */
  visible: boolean;
}

export const CountdownOverlay: React.FC<CountdownOverlayProps> = ({
  initialCount = 3,
  onComplete,
  onCancel,
  centerX,
  centerY,
  visible,
}) => {
  const [count, setCount] = useState(initialCount);
  const [isAnimating, setIsAnimating] = useState(false);

  // Reset count when becoming visible
  useEffect(() => {
    if (visible) {
      setCount(initialCount);
      setIsAnimating(true);
    }
  }, [visible, initialCount]);

  // Handle countdown timer
  useEffect(() => {
    if (!visible || count <= 0) return;

    const timer = setTimeout(() => {
      if (count === 1) {
        // Last count - trigger completion
        onComplete();
        setIsAnimating(false);
      } else {
        setCount(count - 1);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [visible, count, onComplete]);

  // Handle escape key to cancel
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && onCancel) {
      onCancel();
      setIsAnimating(false);
    }
  }, [onCancel]);

  useEffect(() => {
    if (visible) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [visible, handleKeyDown]);

  if (!visible || count <= 0) {
    return null;
  }

  const positionStyle = centerX !== undefined && centerY !== undefined
    ? {
        left: centerX,
        top: centerY,
        transform: 'translate(-50%, -50%)',
      }
    : {
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      };

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none">
      {/* Semi-transparent backdrop */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.4)',
          backdropFilter: 'blur(2px)',
        }}
      />

      {/* Countdown number */}
      <div
        className="absolute"
        style={{
          ...positionStyle,
        }}
      >
        <div
          key={count} // Force re-render for animation
          className={`
            flex items-center justify-center
            w-32 h-32 rounded-full
            ${isAnimating ? 'animate-countdown-pulse' : ''}
          `}
          style={{
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '3px solid rgba(255, 255, 255, 0.2)',
            boxShadow: '0 0 60px rgba(0, 0, 0, 0.5), 0 0 120px rgba(59, 130, 246, 0.3)',
            animation: 'countdown-pop 0.5s ease-out',
          }}
        >
          <span
            className="font-bold"
            style={{
              fontSize: '4rem',
              color: '#fff',
              textShadow: '0 0 20px rgba(59, 130, 246, 0.8)',
            }}
          >
            {count}
          </span>
        </div>

        {/* "Recording starting..." text below */}
        <div
          className="absolute left-1/2 transform -translate-x-1/2 whitespace-nowrap text-center"
          style={{
            top: '100%',
            marginTop: '16px',
            color: 'rgba(255, 255, 255, 0.8)',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          Recording starting...
          <br />
          <span style={{ color: 'rgba(255, 255, 255, 0.5)', fontSize: '12px' }}>
            Press ESC to cancel
          </span>
        </div>
      </div>

      {/* CSS animation keyframes */}
      <style>{`
        @keyframes countdown-pop {
          0% {
            transform: scale(0.5);
            opacity: 0;
          }
          50% {
            transform: scale(1.1);
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }
        
        @keyframes countdown-pulse {
          0%, 100% {
            box-shadow: 0 0 60px rgba(0, 0, 0, 0.5), 0 0 120px rgba(59, 130, 246, 0.3);
          }
          50% {
            box-shadow: 0 0 80px rgba(0, 0, 0, 0.6), 0 0 160px rgba(59, 130, 246, 0.5);
          }
        }
        
        .animate-countdown-pulse {
          animation: countdown-pulse 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
};

export default CountdownOverlay;
