/**
 * ClickHighlightOverlay - Renders click highlight animations on video preview.
 *
 * Displays visual feedback (ripple, spotlight, ring) at click locations
 * during video playback. Animations are triggered by click events from
 * the cursor recording data.
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import { usePreviewOrPlaybackTime } from '../../hooks/usePlaybackEngine';
import type { CursorRecording, ClickHighlightConfig, CursorEvent } from '../../types';

interface ClickHighlightOverlayProps {
  cursorRecording: CursorRecording | null | undefined;
  clickHighlightConfig: ClickHighlightConfig | undefined;
  /** Container width in pixels */
  containerWidth: number;
  /** Container height in pixels */
  containerHeight: number;
}

/**
 * Parse a CSS color string into RGBA values.
 * Supports: #RRGGBB, #RRGGBBAA, rgb(r,g,b), rgba(r,g,b,a)
 */
function parseColor(color: string): { r: number; g: number; b: number; a: number } {
  const defaultColor = { r: 255, g: 107, b: 107, a: 0.5 };
  
  if (!color) return defaultColor;
  
  const trimmed = color.trim();
  
  // Hex format: #RRGGBB or #RRGGBBAA
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 0.5,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
  }
  
  // rgba(r, g, b, a) format
  const rgbaMatch = trimmed.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1], 10),
      g: parseInt(rgbaMatch[2], 10),
      b: parseInt(rgbaMatch[3], 10),
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 0.5,
    };
  }
  
  return defaultColor;
}

/**
 * Get all active click highlights for a given timestamp.
 * Returns click positions with animation progress (0-1).
 */
function getActiveClicks(
  events: CursorEvent[],
  currentTimeMs: number,
  durationMs: number,
  recording: CursorRecording
): Array<{ x: number; y: number; progress: number }> {
  const active: Array<{ x: number; y: number; progress: number }> = [];
  
  for (const event of events) {
    // Only process click-down events (not releases)
    const eventType = event.eventType;
    const isClickDown = 
      (eventType.type === 'leftClick' && eventType.pressed) ||
      (eventType.type === 'rightClick' && eventType.pressed) ||
      (eventType.type === 'middleClick' && eventType.pressed);
    
    if (!isClickDown) continue;
    
    // Check if this click is within the animation window
    const clickTime = event.timestampMs;
    if (currentTimeMs < clickTime) continue; // Click hasn't happened yet
    
    const elapsed = currentTimeMs - clickTime;
    if (elapsed > durationMs) continue; // Animation already finished
    
    // Calculate animation progress (0 = start, 1 = end)
    const progress = elapsed / durationMs;
    
    // Convert screen coordinates to normalized (0-1) coordinates
    const regionX = event.x - recording.regionOffsetX;
    const regionY = event.y - recording.regionOffsetY;
    const normalizedX = regionX / recording.regionWidth;
    const normalizedY = regionY / recording.regionHeight;
    
    active.push({ x: normalizedX, y: normalizedY, progress });
  }
  
  return active;
}

/**
 * Render ripple effect - expanding circle that fades out.
 */
function renderRipple(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  progress: number,
  maxRadius: number,
  r: number,
  g: number,
  b: number,
  baseAlpha: number
) {
  // Ripple expands from 0 to maxRadius with easing
  const easedProgress = 1 - Math.pow(1 - progress, 3); // Ease-out cubic
  const currentRadius = maxRadius * easedProgress;
  
  // Fade out as ripple expands
  const alpha = baseAlpha * (1 - progress);
  
  if (currentRadius <= 0 || alpha <= 0) return;
  
  // Draw filled circle with soft edges using radial gradient
  const innerRadius = currentRadius * 0.7;
  const gradient = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, currentRadius);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  
  ctx.beginPath();
  ctx.arc(cx, cy, currentRadius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
}

/**
 * Render spotlight effect - static glow that fades out.
 */
function renderSpotlight(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  progress: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  baseAlpha: number
) {
  // Spotlight stays same size but fades out
  const alpha = baseAlpha * (1 - progress);
  
  if (alpha <= 0) return;
  
  // Draw gaussian-like glow using radial gradient
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
  gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${alpha * 0.5})`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
}

/**
 * Render ring effect - expanding hollow ring that fades out.
 */
function renderRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  progress: number,
  maxRadius: number,
  r: number,
  g: number,
  b: number,
  baseAlpha: number
) {
  // Ring expands from 0 to maxRadius with easing
  const easedProgress = 1 - Math.pow(1 - progress, 3); // Ease-out cubic
  const currentRadius = maxRadius * easedProgress;
  
  // Fade out as ring expands
  const alpha = baseAlpha * (1 - progress);
  
  if (currentRadius <= 0 || alpha <= 0) return;
  
  // Ring thickness proportional to radius
  const ringThickness = Math.max(currentRadius * 0.15, 2);
  
  ctx.beginPath();
  ctx.arc(cx, cy, currentRadius, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  ctx.lineWidth = ringThickness;
  ctx.stroke();
}

/**
 * ClickHighlightOverlay component - renders click highlight animations on video.
 */
export const ClickHighlightOverlay = memo(function ClickHighlightOverlay({
  cursorRecording,
  clickHighlightConfig,
  containerWidth,
  containerHeight,
}: ClickHighlightOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentTimeMs = usePreviewOrPlaybackTime();
  const lastRenderTimeRef = useRef<number>(-1);
  
  // Get config values with defaults
  const enabled = clickHighlightConfig?.enabled ?? true;
  const color = clickHighlightConfig?.color ?? '#FF6B6B';
  const radius = clickHighlightConfig?.radius ?? 30;
  const durationMs = clickHighlightConfig?.durationMs ?? 400;
  const style = clickHighlightConfig?.style ?? 'ripple';
  
  // Parse color once
  const parsedColor = parseColor(color);
  
  // Render function for the highlight animations
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cursorRecording || !enabled) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Set canvas size to match container
    if (canvas.width !== containerWidth || canvas.height !== containerHeight) {
      canvas.width = containerWidth;
      canvas.height = containerHeight;
    }
    
    // Clear canvas
    ctx.clearRect(0, 0, containerWidth, containerHeight);
    
    // Get active click highlights
    const activeClicks = getActiveClicks(
      cursorRecording.events,
      currentTimeMs,
      durationMs,
      cursorRecording
    );
    
    if (activeClicks.length === 0) return;
    
    // Render each active click highlight
    for (const click of activeClicks) {
      // Convert normalized coordinates to pixel coordinates
      const pixelX = click.x * containerWidth;
      const pixelY = click.y * containerHeight;
      
      // Scale radius based on container size (use smaller dimension as reference)
      const scaleFactor = Math.min(containerWidth, containerHeight) / 1080;
      const scaledRadius = radius * scaleFactor;
      
      switch (style) {
        case 'ripple':
          renderRipple(ctx, pixelX, pixelY, click.progress, scaledRadius, 
            parsedColor.r, parsedColor.g, parsedColor.b, parsedColor.a);
          break;
        case 'spotlight':
          renderSpotlight(ctx, pixelX, pixelY, click.progress, scaledRadius,
            parsedColor.r, parsedColor.g, parsedColor.b, parsedColor.a);
          break;
        case 'ring':
          renderRing(ctx, pixelX, pixelY, click.progress, scaledRadius,
            parsedColor.r, parsedColor.g, parsedColor.b, parsedColor.a);
          break;
      }
    }
  }, [
    cursorRecording,
    enabled,
    radius,
    durationMs,
    style,
    containerWidth,
    containerHeight,
    currentTimeMs,
    parsedColor,
  ]);
  
  // Animation loop for smooth rendering
  useEffect(() => {
    if (!enabled || !cursorRecording) return;
    
    // Only re-render if time changed
    if (lastRenderTimeRef.current === currentTimeMs) return;
    lastRenderTimeRef.current = currentTimeMs;
    
    render();
  }, [enabled, cursorRecording, currentTimeMs, render]);
  
  // Don't render if disabled or no cursor data
  if (!enabled || !cursorRecording || cursorRecording.events.length === 0) {
    return null;
  }
  
  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 14 }} // Below cursor (15), above video content
      width={containerWidth}
      height={containerHeight}
    />
  );
});

export default ClickHighlightOverlay;
