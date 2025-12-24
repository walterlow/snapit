/**
 * RecordingControls - Floating controls shown during active recording.
 *
 * Displays:
 * - Recording indicator (red dot)
 * - Elapsed time
 * - Pause/Resume button (MP4 only)
 * - Stop button
 * - Cancel button
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useVideoRecordingStore, formatElapsedTime } from '../../stores/videoRecordingStore';
import { Square, Pause, Play, X, Circle } from 'lucide-react';

interface RecordingControlsProps {
  /** Optional class name */
  className?: string;
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({ className = '' }) => {
  const {
    recordingState,
    settings,
    stopRecording,
    pauseRecording,
    resumeRecording,
    cancelRecording,
  } = useVideoRecordingStore();

  const [elapsedTime, setElapsedTime] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Update elapsed time from recording state
  useEffect(() => {
    if (recordingState.status === 'recording') {
      setElapsedTime(recordingState.elapsedSecs);
    } else if (recordingState.status === 'paused') {
      setElapsedTime(recordingState.elapsedSecs);
    }
  }, [recordingState]);

  // Local timer for smooth updates between backend events
  useEffect(() => {
    if (recordingState.status !== 'recording') return;

    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 0.1);
    }, 100);

    return () => clearInterval(interval);
  }, [recordingState.status]);

  // Handle stop
  const handleStop = useCallback(async () => {
    await stopRecording();
  }, [stopRecording]);

  // Handle pause/resume
  const handlePauseResume = useCallback(async () => {
    if (recordingState.status === 'paused') {
      await resumeRecording();
    } else {
      await pauseRecording();
    }
  }, [recordingState.status, pauseRecording, resumeRecording]);

  // Handle cancel
  const handleCancel = useCallback(async () => {
    await cancelRecording();
  }, [cancelRecording]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  }, [position]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragOffset.x,
      y: e.clientY - dragOffset.y,
    });
  }, [isDragging, dragOffset]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Only show during recording or paused states
  if (recordingState.status !== 'recording' && recordingState.status !== 'paused') {
    return null;
  }

  const isRecording = recordingState.status === 'recording';
  const isPaused = recordingState.status === 'paused';
  const isGif = settings.format === 'gif';

  return (
    <div
      className={`fixed z-[9999] select-none ${className}`}
      style={{
        left: position.x,
        top: position.y,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        className="flex items-center gap-3 px-4 py-2 rounded-xl shadow-2xl"
        style={{
          background: 'rgba(0, 0, 0, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        {/* Recording indicator */}
        <div className="flex items-center gap-2">
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
          className="px-2 py-0.5 rounded text-xs font-medium uppercase"
          style={{
            background: isGif ? 'rgba(168, 85, 247, 0.3)' : 'rgba(59, 130, 246, 0.3)',
            color: isGif ? '#c084fc' : '#93c5fd',
          }}
        >
          {settings.format}
        </div>

        {/* Divider */}
        <div className="w-px h-6 bg-white/20" />

        {/* Pause/Resume button (not for GIF) */}
        {!isGif && (
          <button
            onClick={handlePauseResume}
            className="p-2 rounded-lg transition-colors hover:bg-white/10"
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
          className="p-2 rounded-lg transition-colors hover:bg-white/10"
          title="Stop and save"
        >
          <Square size={18} className="text-white" fill="currentColor" />
        </button>

        {/* Cancel button */}
        <button
          onClick={handleCancel}
          className="p-2 rounded-lg transition-colors hover:bg-red-500/20"
          title="Cancel recording"
        >
          <X size={18} className="text-red-400" />
        </button>
      </div>

      {/* Drag hint */}
      <div
        className="absolute -bottom-6 left-1/2 transform -translate-x-1/2 text-xs text-white/40 whitespace-nowrap"
      >
        Drag to move
      </div>
    </div>
  );
};

export default RecordingControls;
