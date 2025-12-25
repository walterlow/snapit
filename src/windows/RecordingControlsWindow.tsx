/**
 * RecordingControlsWindow - Simple floating controls during recording.
 * 
 * Shows recording time, format badge, and control buttons.
 * Backend manages window lifecycle (show/hide).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Square, Pause, Play, X, Circle, GripVertical } from 'lucide-react';
import type { RecordingState, RecordingFormat } from '../types';
import { recordingLogger as log } from '../utils/logger';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

type UIStatus = 'starting' | 'recording' | 'paused' | 'processing' | 'error' | 'done';

const RecordingControlsWindow: React.FC = () => {
  const [uiStatus, setUiStatus] = useState<UIStatus>('starting');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Track if we've already started the local timer for current recording session
  const isRecordingActiveRef = useRef(false);

  // Listen to backend events
  useEffect(() => {
    log.info('Setting up event listeners');
    
    const unlistenState = listen<RecordingState>('recording-state-changed', (event) => {
      const state = event.payload;
      log.debug('State changed:', state.status, 'isRecordingActive:', isRecordingActiveRef.current, 'payload:', JSON.stringify(state));
      
      switch (state.status) {
        case 'countdown':
          // New recording session - reset all state
          log.info('Countdown started, resetting state');
          isRecordingActiveRef.current = false;
          setUiStatus('starting');
          setElapsedTime(0);
          setProgress(0);
          break;
        case 'recording':
          // Only reset elapsed time when first transitioning to recording
          // Don't reset on subsequent updates (which happen every ~30 frames)
          if (!isRecordingActiveRef.current) {
            log.info('Recording started (first transition)', 'elapsedSecs:', 'elapsedSecs' in state ? state.elapsedSecs : 0);
            isRecordingActiveRef.current = true;
            setElapsedTime('elapsedSecs' in state ? state.elapsedSecs : 0);
          }
          setUiStatus('recording');
          break;
        case 'paused':
          log.info('Recording paused');
          setUiStatus('paused');
          if ('elapsedSecs' in state) {
            setElapsedTime(state.elapsedSecs);
          }
          break;
        case 'processing':
          log.info('Processing (GIF encoding)', 'progress:', 'progress' in state ? state.progress : 0);
          setUiStatus('processing');
          if ('progress' in state) {
            setProgress(state.progress);
          }
          break;
        case 'completed':
        case 'idle':
          log.info('Recording ended, status:', state.status, 'closing windows');
          isRecordingActiveRef.current = false;
          setUiStatus('done');
          // Reset for next session
          setElapsedTime(0);
          setProgress(0);
          // Hide windows and restore main window
          invoke('hide_recording_border').catch(() => {});
          invoke('hide_recording_controls').catch(() => {});
          invoke('restore_main_window').catch(() => {});
          break;
        case 'error':
          const errorMsg = 'message' in state ? state.message : 'Unknown error';
          log.error('Recording error:', errorMsg);
          isRecordingActiveRef.current = false;
          setErrorMessage(errorMsg);
          setUiStatus('error');
          // Hide border but keep controls visible to show error
          invoke('hide_recording_border').catch(() => {});
          // Auto-close after showing error and restore main window
          setTimeout(() => {
            setUiStatus('done');
            setElapsedTime(0);
            setProgress(0);
            setErrorMessage(null);
            invoke('hide_recording_controls').catch(() => {});
            invoke('restore_main_window').catch(() => {});
          }, 3000);
          break;
      }
    });

    const unlistenFormat = listen<RecordingFormat>('recording-format', (event) => {
      log.debug('Format changed:', event.payload);
      setFormat(event.payload);
    });

    // Get initial state
    invoke<{ state: RecordingState; settings: { format: RecordingFormat } | null }>('get_recording_status')
      .then((result) => {
        log.info('Initial status:', result.state.status, 'format:', result.settings?.format);
        if (result.settings) {
          setFormat(result.settings.format);
        }
        // Only update if actively recording
        if (result.state.status === 'recording') {
          log.debug('Already recording, setting uiStatus to recording');
          setUiStatus('recording');
        } else if (result.state.status === 'paused') {
          setUiStatus('paused');
        } else if (result.state.status === 'processing') {
          setUiStatus('processing');
        }
        // Otherwise stay in 'starting' - wait for live event
      })
      .catch((e) => log.error('Failed to get initial status:', e));

    return () => {
      unlistenState.then(fn => fn());
      unlistenFormat.then(fn => fn());
    };
  }, []);

  // Timer
  useEffect(() => {
    if (uiStatus !== 'recording') return;
    const interval = setInterval(() => setElapsedTime(t => t + 0.1), 100);
    return () => clearInterval(interval);
  }, [uiStatus]);

  // Handlers
  const handleStop = useCallback(() => {
    console.log('[RecordingControls] Stop clicked');
    invoke('stop_recording').catch(e => console.error('Stop failed:', e));
  }, []);

  const handlePauseResume = useCallback(() => {
    console.log('[RecordingControls] Pause/Resume clicked, status:', uiStatus);
    if (uiStatus === 'paused') {
      invoke('resume_recording').catch(e => console.error('Resume failed:', e));
    } else {
      invoke('pause_recording').catch(e => console.error('Pause failed:', e));
    }
  }, [uiStatus]);

  const handleCancel = useCallback(() => {
    console.log('[RecordingControls] Cancel clicked');
    invoke('cancel_recording').catch(e => console.error('Cancel failed:', e));
  }, []);

  // === RENDER ===

  // Starting
  if (uiStatus === 'starting') {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div
          data-tauri-drag-region
          className="flex items-center gap-3 px-6 py-3 rounded-full pointer-events-auto cursor-move"
          style={{
            background: 'rgba(0, 0, 0, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div className="w-3 h-3 border-2 border-white/50 border-t-transparent rounded-full animate-spin" />
          <span className="text-white/50 text-sm select-none">Starting...</span>
          <button
            type="button"
            onClick={handleCancel}
            className="ml-2 p-1 rounded transition-colors hover:bg-red-500/20 cursor-pointer"
            title="Cancel"
          >
            <X size={14} className="text-red-400" />
          </button>
        </div>
      </div>
    );
  }

  // Processing (GIF encoding)
  if (uiStatus === 'processing') {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div
          data-tauri-drag-region
          className="px-6 py-3 rounded-xl pointer-events-auto cursor-move"
          style={{
            background: 'rgba(0, 0, 0, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-white/70 text-sm select-none">
              Encoding GIF... {Math.round(progress * 100)}%
            </span>
            <button
              type="button"
              onClick={handleCancel}
              className="ml-2 p-1 rounded transition-colors hover:bg-red-500/20 cursor-pointer"
              title="Cancel"
            >
              <X size={14} className="text-red-400" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Error state - show error message before closing
  if (uiStatus === 'error') {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div
          data-tauri-drag-region
          className="px-6 py-3 rounded-xl pointer-events-auto cursor-move"
          style={{
            background: 'rgba(0, 0, 0, 0.95)',
            border: '1px solid rgba(239, 68, 68, 0.5)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 rounded-full bg-red-500" />
            <span className="text-red-400 text-sm select-none max-w-[300px] truncate">
              {errorMessage || 'Recording failed'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Done - render nothing while window closes
  if (uiStatus === 'done') {
    return null;
  }

  // Recording / Paused - main controls
  const isRecording = uiStatus === 'recording';
  const isPaused = uiStatus === 'paused';
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
        <div className="text-white/40">
          <GripVertical size={16} />
        </div>

        <div className="flex items-center gap-2 select-none">
          <Circle
            size={12}
            className={isRecording ? 'text-red-500 animate-pulse' : 'text-yellow-500'}
            fill="currentColor"
          />
          <span className="text-white font-mono text-sm font-medium min-w-[60px]">
            {formatTime(elapsedTime)}
          </span>
        </div>

        <div
          className="px-2 py-0.5 rounded text-xs font-medium uppercase select-none"
          style={{
            background: isGif ? 'rgba(168, 85, 247, 0.3)' : 'rgba(59, 130, 246, 0.3)',
            color: isGif ? '#c084fc' : '#93c5fd',
          }}
        >
          {format}
        </div>

        <div className="w-px h-6 bg-white/20" />

        <div className="flex items-center gap-1">
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

          <button
            type="button"
            onClick={handleStop}
            className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-white/10 cursor-pointer"
            title="Stop and save"
          >
            <Square size={16} className="text-white" fill="currentColor" />
          </button>
        </div>

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
