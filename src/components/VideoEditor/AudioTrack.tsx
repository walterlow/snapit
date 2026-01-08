import { memo, useEffect, useRef, useState, useMemo } from 'react';
import { Volume2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { audioLogger } from '../../utils/logger';
import type { AudioWaveform } from '../../types';

interface AudioTrackProps {
  /** Path to audio/video file to extract waveform from */
  audioPath?: string;
  /** Duration of the timeline in milliseconds */
  durationMs: number;
  /** Timeline zoom level (pixels per millisecond) */
  timelineZoom: number;
}

// Maximum samples for performance (like Cap's approach)
const MAX_WAVEFORM_SAMPLES = 6000;

// dB range for scaling (-60dB to -30dB like Cap)
const DB_MIN = -60;
const DB_MAX = -30;

/**
 * Convert linear amplitude to dB scale and normalize to 0-1 range
 */
function linearToDbNormalized(sample: number): number {
  // Avoid log of zero
  const amplitude = Math.abs(sample) + 1e-10;
  // Convert to dB
  const db = 20 * Math.log10(amplitude);
  // Normalize to 0-1 range using -60dB to -30dB scale
  return Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
}

/**
 * Downsample waveform data to target number of samples
 */
function downsampleWaveform(samples: number[], targetSamples: number): number[] {
  if (samples.length <= targetSamples) return samples;

  const ratio = samples.length / targetSamples;
  const downsampled: number[] = [];

  for (let i = 0; i < targetSamples; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);

    // Take the maximum value in each chunk for better visual representation
    let max = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      max = Math.max(max, Math.abs(samples[j]));
    }
    downsampled.push(max);
  }

  return downsampled;
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
          audioLogger.error('Failed to load waveform:', err);
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

  // Process waveform data with dB scaling and downsampling
  const processedSamples = useMemo(() => {
    if (!waveform || waveform.samples.length === 0) return null;

    // Downsample if needed
    let samples = waveform.samples;
    if (samples.length > MAX_WAVEFORM_SAMPLES) {
      samples = downsampleWaveform(samples, MAX_WAVEFORM_SAMPLES);
    }

    // Apply dB scaling for better visual representation
    return samples.map(linearToDbNormalized);
  }, [waveform]);

  // Render waveform to canvas when data or dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !processedSamples || processedSamples.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const totalWidth = durationMs * timelineZoom;
    const height = canvas.height;
    const centerY = height / 2;

    // Set canvas size to match the timeline width
    canvas.width = totalWidth;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, height);

    // Calculate sample spacing
    const samplesCount = processedSamples.length;
    const sampleWidth = totalWidth / samplesCount;

    // Create gradient for waveform using coral/orange theme (SnapIt brand colors)
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(249, 112, 102, 0.9)'); // coral-400
    gradient.addColorStop(0.5, 'rgba(251, 146, 60, 0.7)'); // orange-400
    gradient.addColorStop(1, 'rgba(249, 112, 102, 0.9)');

    ctx.fillStyle = gradient;
    ctx.beginPath();

    // Draw the top half of the waveform
    ctx.moveTo(0, centerY);

    for (let i = 0; i < samplesCount; i++) {
      const x = i * sampleWidth;
      const amplitude = processedSamples[i] * (height / 2 - 2); // Leave 2px margin
      ctx.lineTo(x, centerY - amplitude);
    }

    // Draw the bottom half (mirror)
    for (let i = samplesCount - 1; i >= 0; i--) {
      const x = i * sampleWidth;
      const amplitude = processedSamples[i] * (height / 2 - 2);
      ctx.lineTo(x, centerY + amplitude);
    }

    ctx.closePath();
    ctx.fill();

    // Draw center line
    ctx.strokeStyle = 'rgba(249, 112, 102, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(totalWidth, centerY);
    ctx.stroke();
  }, [processedSamples, durationMs, timelineZoom]);

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
