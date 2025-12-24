/**
 * ActiveRecordingControls - Controls shown during active recording.
 * 
 * Displays inside the overlay (not a separate window) with:
 * - Recording indicator and timer
 * - Pause/Resume button (video only)
 * - Stop button
 * - Cancel button
 */

import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Square, Pause, Play, X, Circle } from 'lucide-react';
import type { RecordingState, RecordingFormat } from '../../types';

// Helper to format elapsed time
function formatElapsedTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

interface ActiveRecordingControlsProps {
  format: RecordingFormat;
}

export const ActiveRecordingControls: React.FC<ActiveRecordingControlsProps> = ({ format }) => {
  const [recordingState, setRecordingState] = useState<RecordingState>({ 
    status: 'recording', 
    startedAt: new Date().toISOString(), 
    elapsedSecs: 0, 
    frameCount: 0 
  });
  const [elapsedTime, setElapsedTime] = useState(0);

  // Listen for recording state changes
  useEffect(() => {
    const unlistenState = listen<RecordingState>('recording-state-changed', (event) => {
      setRecordingState(event.payload);
      
      if (event.payload.status === 'recording' || event.payload.status === 'paused') {
        const state = event.payload as { elapsedSecs?: number };
        if (state.elapsedSecs !== undefined) {
          setElapsedTime(state.elapsedSecs);
        }
      }
    });

    return () => {
      unlistenState.then((fn) => fn());
    };
  }, []);

  // Local timer for smooth updates
  useEffect(() => {
    if (recordingState.status !== 'recording') return;

    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 0.1);
    }, 100);

    return () => clearInterval(interval);
  }, [recordingState.status]);

  // Stop propagation (same pattern as RecordingToolbar)
  const stopPropagation = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

  // Handle stop
  const handleStop = useCallback(async () => {
    try {
      await invoke('stop_recording');
    } catch (error) {
      console.error('Failed to stop recording:', error);
    }
  }, []);

  // Handle pause/resume
  const handlePauseResume = useCallback(async () => {
    try {
      if (recordingState.status === 'paused') {
        await invoke('resume_recording');
      } else {
        await invoke('pause_recording');
      }
    } catch (error) {
      console.error('Failed to pause/resume:', error);
    }
  }, [recordingState.status]);

  // Handle cancel
  const handleCancel = useCallback(async () => {
    try {
      await invoke('cancel_recording');
    } catch (error) {
      console.error('Failed to cancel recording:', error);
    }
  }, []);

  const isRecording = recordingState.status === 'recording';
  const isPaused = recordingState.status === 'paused';
  const isGif = format === 'gif';

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-xl pointer-events-auto"
      style={{
        background: 'rgba(30, 30, 30, 0.95)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      }}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Recording indicator */}
      <div className="flex items-center gap-2 px-2">
        <Circle
          size={12}
          className={`${isRecording ? 'text-red-500 animate-pulse' : 'text-yellow-500'}`}
          fill="currentColor"
        />
        <span className="text-white font-mono text-sm font-medium min-w-[52px]">
          {formatElapsedTime(elapsedTime)}
        </span>
      </div>

      {/* Format badge */}
      <div
        className="px-2 py-0.5 rounded text-xs font-medium uppercase"
        style={{
          background: isGif ? 'rgba(168, 85, 247, 0.3)' : 'rgba(59, 130, 246, 0.3)',
          color: isGif ? '#c084fc' : '#93c5fd',
        }}
      >
        {format}
      </div>

      {/* Divider */}
      <div className="w-px h-8 bg-white/20" />

      {/* Pause/Resume button (not for GIF) */}
      {!isGif && (
        <button
          onClick={handlePauseResume}
          className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors hover:bg-white/10"
          title={isPaused ? 'Resume' : 'Pause'}
        >
          {isPaused ? (
            <Play size={18} className="text-green-400" fill="currentColor" />
          ) : (
            <Pause size={18} className="text-yellow-400" fill="currentColor" />
          )}
        </button>
      )}

      {/* Stop button */}
      <button
        onClick={handleStop}
        className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors hover:bg-white/10"
        title="Stop and save"
      >
        <Square size={18} className="text-white" fill="currentColor" />
      </button>

      {/* Cancel button */}
      <button
        onClick={handleCancel}
        className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors text-white/70 hover:text-red-400 hover:bg-red-500/10"
        title="Cancel recording"
      >
        <X size={18} />
      </button>
    </div>
  );
};

export default ActiveRecordingControls;
