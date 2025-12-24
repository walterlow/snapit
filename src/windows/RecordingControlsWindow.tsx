/**
 * RecordingControlsWindow - Standalone window for recording controls.
 * 
 * This is a separate Tauri window that stays visible during recording,
 * allowing users to pause/resume/stop/cancel without blocking the screen.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Square, Pause, Play, X, Circle, GripVertical } from 'lucide-react';
import type { RecordingState, RecordingFormat } from '../types';

// Helper to format elapsed time
function formatElapsedTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

const RecordingControlsWindow: React.FC = () => {
  const [recordingState, setRecordingState] = useState<RecordingState>({ status: 'idle' });
  const [prevStatus, setPrevStatus] = useState<string>('idle');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);

  // Listen for recording state changes from the backend
  // NOTE: No dependencies - listener is stable across renders
  useEffect(() => {
    const unlistenState = listen<RecordingState>('recording-state-changed', (event) => {
      const newState = event.payload;
      
      // Use functional update to correctly track previous status
      setRecordingState((currentState) => {
        // Update prevStatus with the CURRENT state before it changes
        setPrevStatus(currentState.status);
        return newState;
      });
      
      // Update elapsed time from state - only if backend provides a value > 0
      if (newState.status === 'recording' || newState.status === 'paused') {
        const state = newState as { elapsedSecs?: number };
        if (state.elapsedSecs !== undefined && state.elapsedSecs > 0) {
          setElapsedTime(state.elapsedSecs);
        }
      }
    });

    const unlistenFormat = listen<RecordingFormat>('recording-format', (event) => {
      setFormat(event.payload);
    });

    // Get initial status
    invoke<{ state: RecordingState; settings: { format: RecordingFormat } | null }>('get_recording_status')
      .then((status) => {
        setRecordingState(status.state);
        if (status.settings) {
          setFormat(status.settings.format);
        }
      })
      .catch(console.error);

    return () => {
      unlistenState.then((fn) => fn());
      unlistenFormat.then((fn) => fn());
    };
  }, []); // Empty dependency array - listener is stable

  // Local timer for smooth updates
  useEffect(() => {
    if (recordingState.status !== 'recording') return;

    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 0.1);
    }, 100);

    return () => clearInterval(interval);
  }, [recordingState.status]);

  // Close window when recording completes, errors, or is cancelled
  useEffect(() => {
    const shouldClose = 
      recordingState.status === 'completed' || 
      recordingState.status === 'error' ||
      // Cancelled: went from recording/paused back to idle
      (recordingState.status === 'idle' && (prevStatus === 'recording' || prevStatus === 'paused'));
    
    if (shouldClose) {
      const timer = setTimeout(async () => {
        try {
          const window = getCurrentWindow();
          await window.close();
        } catch {
          // Window might already be closed
        }
      }, 100); // Faster close for cancel
      return () => clearTimeout(timer);
    }
  }, [recordingState.status, prevStatus]);

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

  // Show "Starting..." for idle/countdown states
  if (recordingState.status === 'idle' || recordingState.status === 'countdown') {
    const countdownText = recordingState.status === 'countdown' 
      ? `${(recordingState as { secondsRemaining: number }).secondsRemaining}...`
      : 'Starting...';
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div 
          data-tauri-drag-region
          className="px-6 py-3 rounded-full pointer-events-auto cursor-move"
          style={{
            background: 'rgba(0, 0, 0, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          <span className="text-white/50 text-sm select-none">{countdownText}</span>
        </div>
      </div>
    );
  }
  
  // Hide for completed/error states
  if (recordingState.status === 'completed' || recordingState.status === 'error' || recordingState.status === 'processing') {
    return null;
  }

  const isRecording = recordingState.status === 'recording';
  const isPaused = recordingState.status === 'paused';
  const isGif = format === 'gif';

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div 
        data-tauri-drag-region
        className="flex items-center gap-4 pl-5 pr-0 h-12 rounded-xl pointer-events-auto cursor-move"
        style={{
          background: 'rgba(0, 0, 0, 0.95)',
          border: '2px solid rgba(255, 255, 255, 0.15)',
          boxShadow: '2px 4px 12px rgba(0, 0, 0, 0.15)',
        }}
      >
        {/* Drag handle indicator */}
        <div className="text-white/40">
          <GripVertical size={16} />
        </div>

        {/* Recording indicator */}
        <div className="flex items-center gap-2 select-none">
          <Circle
            size={12}
            className={`${isRecording ? 'text-red-500 animate-pulse' : 'text-yellow-500'}`}
            fill="currentColor"
          />
          <span className="text-white font-mono text-sm font-medium min-w-[60px]">
            {formatElapsedTime(elapsedTime)}
          </span>
        </div>

        {/* Format badge */}
        <div
          className="px-2 py-0.5 rounded text-xs font-medium uppercase select-none"
          style={{
            background: isGif ? 'rgba(168, 85, 247, 0.3)' : 'rgba(59, 130, 246, 0.3)',
            color: isGif ? '#c084fc' : '#93c5fd',
          }}
        >
          {format}
        </div>

        {/* Divider */}
        <div className="w-px h-6 bg-white/20" />

        {/* Buttons group */}
        <div className="flex items-center gap-1">
          {/* Pause/Resume button (not for GIF) */}
          {!isGif && (
            <button
              type="button"
              onClick={handlePauseResume}
              className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-white/10 cursor-pointer"
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? (
                <Play size={16} className="text-green-400" fill="currentColor" />
              ) : (
                <Pause size={16} className="text-yellow-400" fill="currentColor" />
              )}
            </button>
          )}

          {/* Stop button */}
          <button
            type="button"
            onClick={handleStop}
            className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-white/10 cursor-pointer"
            title="Stop and save"
          >
            <Square size={16} className="text-white" fill="currentColor" />
          </button>
        </div>

        {/* Cancel button - flush with right edge */}
        <button
          type="button"
          onClick={handleCancel}
          className="h-full px-4 flex items-center justify-center rounded-r-xl transition-colors hover:bg-red-500/20 cursor-pointer"
          title="Cancel recording"
        >
          <X size={16} className="text-red-400" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
};

export default RecordingControlsWindow;
