import { memo, useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { AudioWaveform } from '../../types';

interface AudioTrackProps {
  /** Path to audio/video file to extract waveform from */
  audioPath: string;
  /** Duration of the timeline in milliseconds */
  durationMs: number;
  /** Timeline zoom level (pixels per millisecond) */
  timelineZoom: number;
}

/**
 * AudioTrack component displays an audio waveform visualization.
 *
 * Fetches waveform data from the Rust backend and renders it
 * as a canvas-based visualization that responds to timeline zoom.
 */
export const AudioTrack = memo(function AudioTrack({
  audioPath,
  durationMs,
  timelineZoom,
}: AudioTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waveform, setWaveform] = useState<AudioWaveform | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch waveform data when audio path changes
  useEffect(() => {
    if (!audioPath) return;

    let cancelled = false;

    async function loadWaveform() {
      setIsLoading(true);
      setError(null);

      try {
        // Request ~200 samples per second for detailed waveform
        const data = await invoke<AudioWaveform>('extract_audio_waveform', {
          audioPath,
          samplesPerSecond: 200,
        });

        if (!cancelled) {
          setWaveform(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          console.error('[AudioTrack] Failed to load waveform:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadWaveform();

    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  // Render waveform to canvas when data or dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform || waveform.samples.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const totalWidth = durationMs * timelineZoom;
    const height = canvas.height;
    const centerY = height / 2;

    // Set canvas size to match the timeline width
    canvas.width = totalWidth;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, height);

    // Draw waveform
    const { samples, samplesPerSecond } = waveform;
    const msPerSample = 1000 / samplesPerSecond;

    // Create gradient for waveform
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(79, 70, 229, 0.8)'); // indigo-600
    gradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.6)'); // indigo-500
    gradient.addColorStop(1, 'rgba(79, 70, 229, 0.8)');

    ctx.fillStyle = gradient;
    ctx.beginPath();

    // Draw the top half of the waveform
    ctx.moveTo(0, centerY);

    for (let i = 0; i < samples.length; i++) {
      const x = (i * msPerSample) * timelineZoom;
      const amplitude = samples[i] * (height / 2 - 2); // Leave 2px margin
      ctx.lineTo(x, centerY - amplitude);
    }

    // Draw the bottom half (mirror)
    for (let i = samples.length - 1; i >= 0; i--) {
      const x = (i * msPerSample) * timelineZoom;
      const amplitude = samples[i] * (height / 2 - 2);
      ctx.lineTo(x, centerY + amplitude);
    }

    ctx.closePath();
    ctx.fill();

    // Draw center line
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(totalWidth, centerY);
    ctx.stroke();
  }, [waveform, durationMs, timelineZoom]);

  const totalWidth = durationMs * timelineZoom;

  return (
    <div className="h-full flex items-stretch">
      {/* Track Label */}
      <div className="flex-shrink-0 w-[100px] bg-zinc-900 border-r border-zinc-800 flex items-center gap-2 px-3">
        <Volume2 className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-xs text-zinc-400">Audio</span>
      </div>

      {/* Waveform Canvas */}
      <div
        className="flex-1 relative bg-zinc-900/50 overflow-hidden"
        style={{ width: totalWidth }}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-zinc-500">Loading waveform...</span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-red-400">Failed to load audio</span>
          </div>
        )}

        {!isLoading && !error && waveform && (
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            style={{ width: totalWidth, height: '100%' }}
            height={32}
          />
        )}

        {!isLoading && !error && !waveform && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-zinc-500">No audio</span>
          </div>
        )}
      </div>
    </div>
  );
});
