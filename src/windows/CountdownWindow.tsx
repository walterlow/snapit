/**
 * CountdownWindow - Full-screen countdown overlay before recording starts.
 * 
 * Shows a large animated countdown (3-2-1) centered on screen.
 * Listens to recording-state-changed events to get countdown values.
 */

import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { RecordingState } from '../types';

const CountdownWindow: React.FC = () => {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const currentWindow = getCurrentWebviewWindow();

    const setup = async () => {
      // NOTE: RecordingState is a discriminated union - TypeScript narrows the type
      // based on `status`, so we can access fields directly without runtime checks.
      unlisten = await listen<RecordingState>('recording-state-changed', (event) => {
        const state = event.payload;
        
        if (state.status === 'countdown') {
          // TypeScript knows `state` has `secondsRemaining` here
          setCount(state.secondsRemaining);
        } else if (state.status === 'recording' || state.status === 'idle' || state.status === 'error') {
          // Countdown finished or cancelled - close this window
          currentWindow.close().catch(console.error);
        }
      });
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, []);

  if (count === null || count <= 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
      {/* Countdown container - no backdrop, just the countdown circle */}
      <div className="relative">
        {/* Countdown circle */}
        <div
          key={count}
          className="flex items-center justify-center w-40 h-40 rounded-full"
          style={{
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '4px solid rgba(249, 112, 102, 0.6)',
            boxShadow: '0 0 80px rgba(249, 112, 102, 0.4), 0 0 160px rgba(249, 112, 102, 0.2)',
            animation: 'countdown-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          <span
            className="font-bold select-none"
            style={{
              fontSize: '5rem',
              color: '#fff',
              textShadow: '0 0 30px rgba(249, 112, 102, 0.8)',
            }}
          >
            {count}
          </span>
        </div>

        {/* Text below */}
        <div
          className="absolute left-1/2 transform -translate-x-1/2 whitespace-nowrap text-center mt-6"
          style={{
            color: 'rgba(255, 255, 255, 0.9)',
            fontSize: '16px',
            fontWeight: 500,
            textShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
          }}
        >
          Recording in {count}...
        </div>
      </div>

      {/* CSS animations */}
      <style>{`
        @keyframes countdown-pop {
          0% {
            transform: scale(0.3);
            opacity: 0;
          }
          60% {
            transform: scale(1.1);
            opacity: 1;
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
};

export default CountdownWindow;
