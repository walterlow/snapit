/**
 * RecordingBorderWindow - Shows a border around the recording region.
 * 
 * This is a transparent click-through window that displays only a border
 * to indicate what area is being recorded.
 */

import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { RecordingState } from '../types';

const RecordingBorderWindow: React.FC = () => {
  const [isPaused, setIsPaused] = useState(false);

  // Listen for recording state changes
  useEffect(() => {
    const unlisten = listen<RecordingState>('recording-state-changed', (event) => {
      const state = event.payload;
      
      if (state.status === 'recording') {
        setIsPaused(false);
      } else if (state.status === 'paused') {
        setIsPaused(true);
      }
      // For idle, completed, error, processing - the window will be closed by Rust
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Border style - red when recording, yellow when paused
  const borderColor = isPaused ? '#F59E0B' : '#EF4444';
  const pulseAnimation = !isPaused ? 'pulse 2s ease-in-out infinite' : 'none';

  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{
        border: `3px solid ${borderColor}`,
        boxShadow: `0 0 0 1px rgba(0, 0, 0, 0.3), inset 0 0 0 1px ${borderColor}40`,
        animation: pulseAnimation,
      }}
    >
      {/* Corner indicators */}
      <div
        className="absolute rounded-full"
        style={{
          top: -5,
          left: -5,
          width: 10,
          height: 10,
          background: borderColor,
          boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          top: -5,
          right: -5,
          width: 10,
          height: 10,
          background: borderColor,
          boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          bottom: -5,
          left: -5,
          width: 10,
          height: 10,
          background: borderColor,
          boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          bottom: -5,
          right: -5,
          width: 10,
          height: 10,
          background: borderColor,
          boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
        }}
      />

      {/* Pulse animation keyframes */}
      <style>{`
        @keyframes pulse {
          0%, 100% {
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3), inset 0 0 0 1px ${borderColor}40;
          }
          50% {
            box-shadow: 0 0 8px 2px ${borderColor}60, inset 0 0 0 1px ${borderColor}40;
          }
        }
      `}</style>
    </div>
  );
};

export default RecordingBorderWindow;
