import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Crop, Lock, Unlock, Maximize2, RotateCcw } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CropConfig, CompositionConfig } from '../../types';

interface CropDialogProps {
  open: boolean;
  onClose: () => void;
  onApply: (crop: CropConfig, composition: CompositionConfig) => void;
  /** Original video width (before crop) */
  videoWidth: number;
  /** Original video height (before crop) */
  videoHeight: number;
  initialCrop?: CropConfig;
  initialComposition?: CompositionConfig;
  videoPath?: string;
}

// Common aspect ratios for snapping
const COMMON_RATIOS: [number, number][] = [
  [1, 1],
  [4, 3],
  [3, 2],
  [16, 9],
  [9, 16],
  [16, 10],
  [21, 9],
];

// Aspect ratio presets for video crop
const ASPECT_PRESETS = [
  { label: 'Free', value: null },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: 'Original', value: 'original' as const },
];

// Composition aspect ratio presets
const COMPOSITION_PRESETS = [
  { label: 'Auto', value: 'auto', ratio: null, description: 'Match video crop' },
  { label: '16:9', value: '16:9', ratio: 16 / 9, description: 'Widescreen' },
  { label: '9:16', value: '9:16', ratio: 9 / 16, description: 'Portrait/TikTok' },
  { label: '1:1', value: '1:1', ratio: 1, description: 'Square/Instagram' },
  { label: '4:3', value: '4:3', ratio: 4 / 3, description: 'Standard' },
  { label: '4:5', value: '4:5', ratio: 4 / 5, description: 'Instagram Portrait' },
];

// Snap threshold for aspect ratio detection
const SNAP_THRESHOLD = 0.03;

// Animation duration in ms
const ANIMATION_DURATION = 200;

// Easing function
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Find closest common aspect ratio within threshold
 */
function findClosestRatio(width: number, height: number): [number, number] | null {
  const currentRatio = width / height;
  for (const [w, h] of COMMON_RATIOS) {
    const ratio = w / h;
    if (Math.abs(currentRatio - ratio) < SNAP_THRESHOLD) {
      return [w, h];
    }
    // Also check inverted
    const invertedRatio = h / w;
    if (Math.abs(currentRatio - invertedRatio) < SNAP_THRESHOLD) {
      return [h, w];
    }
  }
  return null;
}

/**
 * CropPreview - Visual cropper component with draggable crop rectangle
 * Note: This crops the video content only. Webcam overlay is added during composition.
 */
const CropPreview = memo(function CropPreview({
  crop,
  displayCrop,
  onCropChange,
  videoWidth,
  videoHeight,
  videoPath,
  snappedRatio,
  onSnappedRatioChange,
}: {
  crop: CropConfig;
  displayCrop: CropConfig; // Animated display values
  onCropChange: (crop: CropConfig, animate?: boolean) => void;
  videoWidth: number;
  videoHeight: number;
  videoPath?: string;
  snappedRatio: [number, number] | null;
  onSnappedRatioChange: (ratio: [number, number] | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dragType, setDragType] = useState<'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br' | 'resize-t' | 'resize-b' | 'resize-l' | 'resize-r' | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; crop: CropConfig } | null>(null);

  // Calculate scale factor to fit video in preview area
  const maxPreviewWidth = 600;
  const maxPreviewHeight = 400;
  const scaleX = maxPreviewWidth / videoWidth;
  const scaleY = maxPreviewHeight / videoHeight;
  const scale = Math.min(scaleX, scaleY, 1);

  const previewWidth = videoWidth * scale;
  const previewHeight = videoHeight * scale;

  // Convert crop to preview coordinates (use animated displayCrop)
  const cropLeft = displayCrop.x * scale;
  const cropTop = displayCrop.y * scale;
  const cropWidth = displayCrop.width * scale;
  const cropHeight = displayCrop.height * scale;

  // Set video to first frame
  useEffect(() => {
    if (videoRef.current && videoPath) {
      videoRef.current.currentTime = 0;
    }
  }, [videoPath]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    type: typeof dragType
  ) => {
    e.preventDefault();
    e.stopPropagation();

    setDragType(type);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      crop: { ...crop },
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current || !containerRef.current) return;

      const deltaX = (moveEvent.clientX - dragStartRef.current.x) / scale;
      const deltaY = (moveEvent.clientY - dragStartRef.current.y) / scale;

      const startCrop = dragStartRef.current.crop;
      const newCrop = { ...crop };

      const minSize = 50; // Minimum crop size in pixels

      switch (type) {
        case 'move':
          newCrop.x = Math.max(0, Math.min(videoWidth - startCrop.width, startCrop.x + deltaX));
          newCrop.y = Math.max(0, Math.min(videoHeight - startCrop.height, startCrop.y + deltaY));
          break;

        case 'resize-tl': {
          newCrop.x = Math.max(0, Math.min(startCrop.x + startCrop.width - minSize, startCrop.x + deltaX));
          newCrop.y = Math.max(0, Math.min(startCrop.y + startCrop.height - minSize, startCrop.y + deltaY));
          newCrop.width = startCrop.x + startCrop.width - newCrop.x;
          newCrop.height = startCrop.y + startCrop.height - newCrop.y;
          break;
        }

        case 'resize-tr': {
          newCrop.y = Math.max(0, Math.min(startCrop.y + startCrop.height - minSize, startCrop.y + deltaY));
          newCrop.width = Math.max(minSize, Math.min(videoWidth - startCrop.x, startCrop.width + deltaX));
          newCrop.height = startCrop.y + startCrop.height - newCrop.y;
          break;
        }

        case 'resize-bl': {
          newCrop.x = Math.max(0, Math.min(startCrop.x + startCrop.width - minSize, startCrop.x + deltaX));
          newCrop.width = startCrop.x + startCrop.width - newCrop.x;
          newCrop.height = Math.max(minSize, Math.min(videoHeight - startCrop.y, startCrop.height + deltaY));
          break;
        }

        case 'resize-br':
          newCrop.width = Math.max(minSize, Math.min(videoWidth - startCrop.x, startCrop.width + deltaX));
          newCrop.height = Math.max(minSize, Math.min(videoHeight - startCrop.y, startCrop.height + deltaY));
          break;

        case 'resize-t':
          newCrop.y = Math.max(0, Math.min(startCrop.y + startCrop.height - minSize, startCrop.y + deltaY));
          newCrop.height = startCrop.y + startCrop.height - newCrop.y;
          break;

        case 'resize-b':
          newCrop.height = Math.max(minSize, Math.min(videoHeight - startCrop.y, startCrop.height + deltaY));
          break;

        case 'resize-l':
          newCrop.x = Math.max(0, Math.min(startCrop.x + startCrop.width - minSize, startCrop.x + deltaX));
          newCrop.width = startCrop.x + startCrop.width - newCrop.x;
          break;

        case 'resize-r':
          newCrop.width = Math.max(minSize, Math.min(videoWidth - startCrop.x, startCrop.width + deltaX));
          break;
      }

      // Round values
      newCrop.x = Math.round(newCrop.x);
      newCrop.y = Math.round(newCrop.y);
      newCrop.width = Math.round(newCrop.width);
      newCrop.height = Math.round(newCrop.height);

      // Apply aspect ratio constraint if locked
      if (crop.lockAspectRatio && crop.aspectRatio) {
        const isVerticalResize = type === 'resize-t' || type === 'resize-b';
        const isHorizontalResize = type === 'resize-l' || type === 'resize-r';

        if (isVerticalResize) {
          newCrop.width = Math.round(newCrop.height * crop.aspectRatio);
        } else if (isHorizontalResize) {
          newCrop.height = Math.round(newCrop.width / crop.aspectRatio);
        } else {
          // Corner resize - use dominant direction
          const targetHeight = newCrop.width / crop.aspectRatio;
          newCrop.height = Math.round(targetHeight);
        }

        // Ensure we don't exceed bounds after ratio adjustment
        if (newCrop.x + newCrop.width > videoWidth) {
          newCrop.width = videoWidth - newCrop.x;
          newCrop.height = Math.round(newCrop.width / crop.aspectRatio);
        }
        if (newCrop.y + newCrop.height > videoHeight) {
          newCrop.height = videoHeight - newCrop.y;
          newCrop.width = Math.round(newCrop.height * crop.aspectRatio);
        }
      } else if (type !== 'move') {
        // Free resize - check for snap to common ratios
        const snapRatio = findClosestRatio(newCrop.width, newCrop.height);
        if (snapRatio && !snappedRatio) {
          onSnappedRatioChange(snapRatio);
        } else if (!snapRatio && snappedRatio) {
          onSnappedRatioChange(null);
        }

        // Apply snap if detected
        if (snapRatio) {
          const targetRatio = snapRatio[0] / snapRatio[1];
          const isVerticalDominant = type === 'resize-t' || type === 'resize-b';
          if (isVerticalDominant) {
            newCrop.width = Math.round(newCrop.height * targetRatio);
          } else {
            newCrop.height = Math.round(newCrop.width / targetRatio);
          }
        }
      }

      onCropChange(newCrop, false); // Don't animate during drag
    };

    const handleMouseUp = () => {
      setDragType(null);
      dragStartRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [crop, scale, videoWidth, videoHeight, onCropChange, snappedRatio, onSnappedRatioChange]);

  const videoSrc = useMemo(() => {
    if (!videoPath) return undefined;
    return convertFileSrc(videoPath);
  }, [videoPath]);

  return (
    <div
      ref={containerRef}
      className="relative bg-[var(--polar-steel)] rounded-lg overflow-hidden"
      style={{ width: previewWidth, height: previewHeight }}
    >
      {/* Video preview */}
      {videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ pointerEvents: 'none' }}
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--ink-muted)]">
          <span className="text-sm">Video Preview</span>
        </div>
      )}

      {/* Dark overlay outside crop area */}
      <div
        className="absolute inset-0 bg-black/60 pointer-events-none"
        style={{
          clipPath: `polygon(
            0 0, 100% 0, 100% 100%, 0 100%, 0 0,
            ${cropLeft}px ${cropTop}px,
            ${cropLeft}px ${cropTop + cropHeight}px,
            ${cropLeft + cropWidth}px ${cropTop + cropHeight}px,
            ${cropLeft + cropWidth}px ${cropTop}px,
            ${cropLeft}px ${cropTop}px
          )`,
        }}
      />

      {/* Crop rectangle */}
      <div
        className="absolute border-2 border-white shadow-lg"
        style={{
          left: cropLeft,
          top: cropTop,
          width: cropWidth,
          height: cropHeight,
          cursor: dragType === 'move' ? 'grabbing' : 'grab',
        }}
      >
        {/* Move area */}
        <div
          className="absolute inset-2 cursor-grab active:cursor-grabbing"
          onMouseDown={(e) => handleMouseDown(e, 'move')}
        />

        {/* Corner handles - L-shaped like Cap */}
        {/* Top-left */}
        <div
          className="absolute -left-0.5 -top-0.5 w-5 h-5 cursor-nwse-resize"
          onMouseDown={(e) => handleMouseDown(e, 'resize-tl')}
        >
          <svg viewBox="0 0 20 20" className="w-full h-full drop-shadow-md">
            <path d="M2 2 H14 M2 2 V14" stroke="white" strokeWidth="3" strokeLinecap="square" fill="none" />
          </svg>
        </div>
        {/* Top-right */}
        <div
          className="absolute -right-0.5 -top-0.5 w-5 h-5 cursor-nesw-resize"
          onMouseDown={(e) => handleMouseDown(e, 'resize-tr')}
        >
          <svg viewBox="0 0 20 20" className="w-full h-full drop-shadow-md">
            <path d="M18 2 H6 M18 2 V14" stroke="white" strokeWidth="3" strokeLinecap="square" fill="none" />
          </svg>
        </div>
        {/* Bottom-left */}
        <div
          className="absolute -left-0.5 -bottom-0.5 w-5 h-5 cursor-nesw-resize"
          onMouseDown={(e) => handleMouseDown(e, 'resize-bl')}
        >
          <svg viewBox="0 0 20 20" className="w-full h-full drop-shadow-md">
            <path d="M2 18 H14 M2 18 V6" stroke="white" strokeWidth="3" strokeLinecap="square" fill="none" />
          </svg>
        </div>
        {/* Bottom-right */}
        <div
          className="absolute -right-0.5 -bottom-0.5 w-5 h-5 cursor-nwse-resize"
          onMouseDown={(e) => handleMouseDown(e, 'resize-br')}
        >
          <svg viewBox="0 0 20 20" className="w-full h-full drop-shadow-md">
            <path d="M18 18 H6 M18 18 V6" stroke="white" strokeWidth="3" strokeLinecap="square" fill="none" />
          </svg>
        </div>

        {/* Edge handles */}
        <div
          className="absolute top-1/2 -left-1 w-2 h-6 -translate-y-1/2 bg-white rounded-full cursor-ew-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-l')}
        />
        <div
          className="absolute top-1/2 -right-1 w-2 h-6 -translate-y-1/2 bg-white rounded-full cursor-ew-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-r')}
        />
        <div
          className="absolute left-1/2 -top-1 w-6 h-2 -translate-x-1/2 bg-white rounded-full cursor-ns-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-t')}
        />
        <div
          className="absolute left-1/2 -bottom-1 w-6 h-2 -translate-x-1/2 bg-white rounded-full cursor-ns-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-b')}
        />

        {/* Grid lines (rule of thirds) - only show during drag */}
        {dragType && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/40" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/40" />
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/40" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/40" />
          </div>
        )}

        {/* Snapped ratio indicator */}
        {snappedRatio && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded-full whitespace-nowrap border border-white/30">
            {snappedRatio[0]}:{snappedRatio[1]}
          </div>
        )}

        {/* Size indicator */}
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
          {crop.width} × {crop.height}
        </div>
      </div>
    </div>
  );
});

/**
 * CropDialog - Modal dialog for interactive video cropping
 *
 * This crops the VIDEO content only, before composition.
 * The cropped video is then placed in the composition canvas (which may have a different aspect ratio).
 * Webcam overlay is added during composition, not affected by video crop.
 *
 * Crop is non-destructive - stored in project config and applied during export.
 */
export const CropDialog = memo(function CropDialog({
  open,
  onClose,
  onApply,
  videoWidth,
  videoHeight,
  initialCrop,
  initialComposition,
  videoPath,
}: CropDialogProps) {
  // Default composition (auto mode)
  const defaultComposition: CompositionConfig = useMemo(() => ({
    mode: 'auto',
    aspectRatio: null,
    aspectPreset: null,
  }), []);

  // Compute a sensible default crop (centered, 80% of video size)
  const defaultCrop = useMemo((): CropConfig => {
    const cropWidth = Math.round(videoWidth * 0.8);
    const cropHeight = Math.round(videoHeight * 0.8);
    return {
      enabled: true,
      x: Math.round((videoWidth - cropWidth) / 2),
      y: Math.round((videoHeight - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
      lockAspectRatio: false,
      aspectRatio: null,
    };
  }, [videoWidth, videoHeight]);

  // Use initialCrop if valid (has non-zero dimensions), otherwise use default
  const computeInitialCrop = useCallback(() => {
    if (initialCrop && initialCrop.width > 0 && initialCrop.height > 0) {
      return initialCrop;
    }
    return defaultCrop;
  }, [initialCrop, defaultCrop]);

  // Use initialComposition or default
  const computeInitialComposition = useCallback(() => {
    if (initialComposition) {
      return initialComposition;
    }
    return defaultComposition;
  }, [initialComposition, defaultComposition]);

  const [crop, setCrop] = useState<CropConfig>(computeInitialCrop);
  const [displayCrop, setDisplayCrop] = useState<CropConfig>(computeInitialCrop);
  const [composition, setComposition] = useState<CompositionConfig>(computeInitialComposition);
  const [snappedRatio, setSnappedRatio] = useState<[number, number] | null>(null);
  const animationRef = useRef<number | null>(null);

  // Reset crop and composition when dialog opens
  useEffect(() => {
    if (open) {
      const initialCropVal = computeInitialCrop();
      setCrop(initialCropVal);
      setDisplayCrop(initialCropVal);
      setComposition(computeInitialComposition());
      setSnappedRatio(null);
    }
  }, [open, computeInitialCrop, computeInitialComposition]);

  // Animate crop changes
  const animateTo = useCallback((target: CropConfig) => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    const start = { ...displayCrop };
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(1, elapsed / ANIMATION_DURATION);
      const eased = easeOutCubic(progress);

      setDisplayCrop({
        ...target,
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased),
        width: Math.round(start.width + (target.width - start.width) * eased),
        height: Math.round(start.height + (target.height - start.height) * eased),
      });

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        animationRef.current = null;
      }
    };

    animationRef.current = requestAnimationFrame(animate);
  }, [displayCrop]);

  const handleCropChange = useCallback((newCrop: CropConfig, animate = true) => {
    setCrop(newCrop);
    if (animate) {
      animateTo(newCrop);
    } else {
      setDisplayCrop(newCrop);
    }
  }, [animateTo]);

  const handleAspectPreset = useCallback((value: string | null) => {
    if (value === null || value === '') {
      // Free aspect
      const newCrop = {
        ...crop,
        lockAspectRatio: false,
        aspectRatio: null,
      };
      handleCropChange(newCrop, true);
      setSnappedRatio(null);
    } else if (value === 'original') {
      // Original video aspect
      const originalAspect = videoWidth / videoHeight;
      const newHeight = Math.round(crop.width / originalAspect);
      const newCrop = {
        ...crop,
        lockAspectRatio: true,
        aspectRatio: originalAspect,
        height: Math.min(newHeight, videoHeight - crop.y),
      };
      handleCropChange(newCrop, true);
      setSnappedRatio(null);
    } else {
      // Specific aspect ratio
      const ratio = parseFloat(value);
      const newHeight = Math.round(crop.width / ratio);

      // Ensure new height fits within bounds
      let finalHeight = Math.min(newHeight, videoHeight - crop.y);
      let finalWidth = Math.round(finalHeight * ratio);

      // If width would exceed bounds, constrain by width instead
      if (crop.x + finalWidth > videoWidth) {
        finalWidth = videoWidth - crop.x;
        finalHeight = Math.round(finalWidth / ratio);
      }

      const newCrop = {
        ...crop,
        lockAspectRatio: true,
        aspectRatio: ratio,
        width: finalWidth,
        height: finalHeight,
      };
      handleCropChange(newCrop, true);
      setSnappedRatio(null);
    }
  }, [crop, videoWidth, videoHeight, handleCropChange]);

  const handleToggleLock = useCallback(() => {
    const newCrop = {
      ...crop,
      lockAspectRatio: !crop.lockAspectRatio,
      aspectRatio: crop.lockAspectRatio ? null : crop.width / crop.height,
    };
    handleCropChange(newCrop, false);
  }, [crop, handleCropChange]);

  const handleReset = useCallback(() => {
    const newCrop = {
      enabled: false,
      x: 0,
      y: 0,
      width: videoWidth,
      height: videoHeight,
      lockAspectRatio: false,
      aspectRatio: null,
    };
    handleCropChange(newCrop, true);
    setSnappedRatio(null);
  }, [videoWidth, videoHeight, handleCropChange]);

  const handleFill = useCallback(() => {
    // Maximize crop within aspect ratio
    if (crop.lockAspectRatio && crop.aspectRatio) {
      const videoAspect = videoWidth / videoHeight;
      let newCrop: CropConfig;

      if (crop.aspectRatio > videoAspect) {
        // Crop is wider than video - constrain by width
        const newHeight = Math.round(videoWidth / crop.aspectRatio);
        newCrop = {
          ...crop,
          x: 0,
          y: Math.round((videoHeight - newHeight) / 2),
          width: videoWidth,
          height: newHeight,
        };
      } else {
        // Crop is taller than video - constrain by height
        const newWidth = Math.round(videoHeight * crop.aspectRatio);
        newCrop = {
          ...crop,
          x: Math.round((videoWidth - newWidth) / 2),
          y: 0,
          width: newWidth,
          height: videoHeight,
        };
      }
      handleCropChange(newCrop, true);
    } else {
      // No aspect ratio lock, fill entire video
      const newCrop = {
        ...crop,
        x: 0,
        y: 0,
        width: videoWidth,
        height: videoHeight,
      };
      handleCropChange(newCrop, true);
    }
  }, [crop, videoWidth, videoHeight, handleCropChange]);

  const handleCompositionPreset = useCallback((presetValue: string) => {
    const preset = COMPOSITION_PRESETS.find(p => p.value === presetValue);
    if (!preset) return;

    if (preset.value === 'auto') {
      setComposition({
        mode: 'auto',
        aspectRatio: null,
        aspectPreset: null,
      });
    } else {
      setComposition({
        mode: 'manual',
        aspectRatio: preset.ratio,
        aspectPreset: preset.value,
      });
    }
  }, []);

  const handleApply = useCallback(() => {
    const finalCrop: CropConfig = {
      ...crop,
      enabled: crop.width !== videoWidth || crop.height !== videoHeight || crop.x !== 0 || crop.y !== 0,
    };
    onApply(finalCrop, composition);
    onClose();
  }, [crop, composition, videoWidth, videoHeight, onApply, onClose]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-[700px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crop className="w-5 h-5" />
            Crop Video
          </DialogTitle>
          <DialogDescription>
            Crop the video content. The cropped video will be placed within the composition canvas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Crop preview */}
          <div className="flex justify-center">
            <CropPreview
              crop={crop}
              displayCrop={displayCrop}
              onCropChange={handleCropChange}
              videoWidth={videoWidth}
              videoHeight={videoHeight}
              videoPath={videoPath}
              snappedRatio={snappedRatio}
              onSnappedRatioChange={setSnappedRatio}
            />
          </div>

          {/* Video Crop aspect ratio presets */}
          <div className="space-y-2">
            <Label>Video Crop Aspect Ratio</Label>
            <ToggleGroup
              type="single"
              value={crop.lockAspectRatio ? (crop.aspectRatio?.toString() || 'original') : ''}
              onValueChange={handleAspectPreset}
              className="justify-start flex-wrap"
            >
              {ASPECT_PRESETS.map((preset) => (
                <ToggleGroupItem
                  key={preset.label}
                  value={preset.value?.toString() || ''}
                  className="text-xs"
                >
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {/* Composition aspect ratio (output canvas) */}
          <div className="space-y-2">
            <Label>Composition (Output Canvas)</Label>
            <ToggleGroup
              type="single"
              value={composition.mode === 'auto' ? 'auto' : (composition.aspectPreset || '')}
              onValueChange={handleCompositionPreset}
              className="justify-start flex-wrap"
            >
              {COMPOSITION_PRESETS.map((preset) => (
                <ToggleGroupItem
                  key={preset.value}
                  value={preset.value}
                  className="text-xs"
                  title={preset.description}
                >
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {composition.mode === 'manual' && (
              <p className="text-xs text-[var(--ink-muted)]">
                Cropped video will be centered within a {composition.aspectPreset} canvas
              </p>
            )}
          </div>

          {/* Position and size inputs */}
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">X</Label>
              <Input
                type="number"
                value={crop.x}
                onChange={(e) => {
                  const newCrop = { ...crop, x: Math.max(0, parseInt(e.target.value) || 0) };
                  handleCropChange(newCrop, true);
                }}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Y</Label>
              <Input
                type="number"
                value={crop.y}
                onChange={(e) => {
                  const newCrop = { ...crop, y: Math.max(0, parseInt(e.target.value) || 0) };
                  handleCropChange(newCrop, true);
                }}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Width</Label>
              <Input
                type="number"
                value={crop.width}
                onChange={(e) => {
                  const w = Math.max(50, parseInt(e.target.value) || 50);
                  const newCrop = {
                    ...crop,
                    width: w,
                    height: crop.lockAspectRatio && crop.aspectRatio ? Math.round(w / crop.aspectRatio) : crop.height,
                  };
                  handleCropChange(newCrop, true);
                }}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Height</Label>
              <Input
                type="number"
                value={crop.height}
                onChange={(e) => {
                  const h = Math.max(50, parseInt(e.target.value) || 50);
                  const newCrop = {
                    ...crop,
                    height: h,
                    width: crop.lockAspectRatio && crop.aspectRatio ? Math.round(h * crop.aspectRatio) : crop.width,
                  };
                  handleCropChange(newCrop, true);
                }}
                className="h-8"
              />
            </div>
          </div>

          {/* Action buttons row */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleLock}
              className="gap-1.5"
            >
              {crop.lockAspectRatio ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              {crop.lockAspectRatio ? 'Locked' : 'Unlocked'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleFill} className="gap-1.5">
              <Maximize2 className="w-3.5 h-3.5" />
              Fill
            </Button>
            <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5">
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleApply}>
            Apply Crop
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
