import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { Crop, Lock, Unlock, Maximize2, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CropConfig } from '../../types';

interface CropDialogProps {
  open: boolean;
  onClose: () => void;
  onApply: (crop: CropConfig) => void;
  videoWidth: number;
  videoHeight: number;
  initialCrop?: CropConfig;
  previewImageUrl?: string;
}

// Aspect ratio presets
const ASPECT_PRESETS = [
  { label: 'Free', value: null },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: 'Original', value: 'original' as const },
];

/**
 * CropPreview - Visual cropper component with draggable crop rectangle
 */
const CropPreview = memo(function CropPreview({
  crop,
  onCropChange,
  videoWidth,
  videoHeight,
  previewImageUrl,
}: {
  crop: CropConfig;
  onCropChange: (crop: CropConfig) => void;
  videoWidth: number;
  videoHeight: number;
  previewImageUrl?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
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

  // Convert crop to preview coordinates
  const cropLeft = crop.x * scale;
  const cropTop = crop.y * scale;
  const cropWidth = crop.width * scale;
  const cropHeight = crop.height * scale;

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

        case 'resize-tl':
          newCrop.x = Math.max(0, Math.min(startCrop.x + startCrop.width - minSize, startCrop.x + deltaX));
          newCrop.y = Math.max(0, Math.min(startCrop.y + startCrop.height - minSize, startCrop.y + deltaY));
          newCrop.width = startCrop.x + startCrop.width - newCrop.x;
          newCrop.height = startCrop.y + startCrop.height - newCrop.y;
          if (crop.lockAspectRatio && crop.aspectRatio) {
            newCrop.height = newCrop.width / crop.aspectRatio;
          }
          break;

        case 'resize-tr':
          newCrop.y = Math.max(0, Math.min(startCrop.y + startCrop.height - minSize, startCrop.y + deltaY));
          newCrop.width = Math.max(minSize, Math.min(videoWidth - startCrop.x, startCrop.width + deltaX));
          newCrop.height = startCrop.y + startCrop.height - newCrop.y;
          if (crop.lockAspectRatio && crop.aspectRatio) {
            newCrop.height = newCrop.width / crop.aspectRatio;
          }
          break;

        case 'resize-bl':
          newCrop.x = Math.max(0, Math.min(startCrop.x + startCrop.width - minSize, startCrop.x + deltaX));
          newCrop.width = startCrop.x + startCrop.width - newCrop.x;
          newCrop.height = Math.max(minSize, Math.min(videoHeight - startCrop.y, startCrop.height + deltaY));
          if (crop.lockAspectRatio && crop.aspectRatio) {
            newCrop.width = newCrop.height * crop.aspectRatio;
          }
          break;

        case 'resize-br':
          newCrop.width = Math.max(minSize, Math.min(videoWidth - startCrop.x, startCrop.width + deltaX));
          newCrop.height = Math.max(minSize, Math.min(videoHeight - startCrop.y, startCrop.height + deltaY));
          if (crop.lockAspectRatio && crop.aspectRatio) {
            newCrop.height = newCrop.width / crop.aspectRatio;
          }
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

      onCropChange(newCrop);
    };

    const handleMouseUp = () => {
      setDragType(null);
      dragStartRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [crop, scale, videoWidth, videoHeight, onCropChange]);

  return (
    <div
      ref={containerRef}
      className="relative bg-[var(--polar-steel)] rounded-lg overflow-hidden"
      style={{ width: previewWidth, height: previewHeight }}
    >
      {/* Video preview or placeholder */}
      {previewImageUrl ? (
        <img
          src={previewImageUrl}
          alt="Video preview"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ pointerEvents: 'none' }}
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

        {/* Corner handles */}
        <div
          className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-white rounded-full cursor-nwse-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-tl')}
        />
        <div
          className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-white rounded-full cursor-nesw-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-tr')}
        />
        <div
          className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-white rounded-full cursor-nesw-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-bl')}
        />
        <div
          className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-white rounded-full cursor-nwse-resize shadow"
          onMouseDown={(e) => handleMouseDown(e, 'resize-br')}
        />

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

        {/* Grid lines */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
          <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
          <div className="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
        </div>

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
 */
export const CropDialog = memo(function CropDialog({
  open,
  onClose,
  onApply,
  videoWidth,
  videoHeight,
  initialCrop,
  previewImageUrl,
}: CropDialogProps) {
  const [crop, setCrop] = useState<CropConfig>(() => initialCrop || {
    enabled: true,
    x: 0,
    y: 0,
    width: videoWidth,
    height: videoHeight,
    lockAspectRatio: false,
    aspectRatio: null,
  });

  // Reset crop when dialog opens
  useEffect(() => {
    if (open) {
      setCrop(initialCrop || {
        enabled: true,
        x: 0,
        y: 0,
        width: videoWidth,
        height: videoHeight,
        lockAspectRatio: false,
        aspectRatio: null,
      });
    }
  }, [open, initialCrop, videoWidth, videoHeight]);

  const handleCropChange = useCallback((newCrop: CropConfig) => {
    setCrop(newCrop);
  }, []);

  const handleAspectPreset = useCallback((value: string | null) => {
    if (value === null || value === '') {
      // Free aspect
      setCrop((prev) => ({
        ...prev,
        lockAspectRatio: false,
        aspectRatio: null,
      }));
    } else if (value === 'original') {
      // Original video aspect
      const originalAspect = videoWidth / videoHeight;
      setCrop((prev) => ({
        ...prev,
        lockAspectRatio: true,
        aspectRatio: originalAspect,
        height: Math.round(prev.width / originalAspect),
      }));
    } else {
      // Specific aspect ratio
      const ratio = parseFloat(value);
      setCrop((prev) => ({
        ...prev,
        lockAspectRatio: true,
        aspectRatio: ratio,
        height: Math.round(prev.width / ratio),
      }));
    }
  }, [videoWidth, videoHeight]);

  const handleToggleLock = useCallback(() => {
    setCrop((prev) => ({
      ...prev,
      lockAspectRatio: !prev.lockAspectRatio,
      aspectRatio: prev.lockAspectRatio ? null : prev.width / prev.height,
    }));
  }, []);

  const handleReset = useCallback(() => {
    setCrop({
      enabled: false,
      x: 0,
      y: 0,
      width: videoWidth,
      height: videoHeight,
      lockAspectRatio: false,
      aspectRatio: null,
    });
  }, [videoWidth, videoHeight]);

  const handleFill = useCallback(() => {
    // Maximize crop within aspect ratio
    if (crop.lockAspectRatio && crop.aspectRatio) {
      const videoAspect = videoWidth / videoHeight;
      if (crop.aspectRatio > videoAspect) {
        // Crop is wider than video
        setCrop((prev) => ({
          ...prev,
          x: 0,
          y: Math.round((videoHeight - videoWidth / prev.aspectRatio!) / 2),
          width: videoWidth,
          height: Math.round(videoWidth / prev.aspectRatio!),
        }));
      } else {
        // Crop is taller than video
        setCrop((prev) => ({
          ...prev,
          x: Math.round((videoWidth - videoHeight * prev.aspectRatio!) / 2),
          y: 0,
          width: Math.round(videoHeight * prev.aspectRatio!),
          height: videoHeight,
        }));
      }
    } else {
      // No aspect ratio lock, fill entire video
      setCrop((prev) => ({
        ...prev,
        x: 0,
        y: 0,
        width: videoWidth,
        height: videoHeight,
      }));
    }
  }, [crop.lockAspectRatio, crop.aspectRatio, videoWidth, videoHeight]);

  const handleApply = useCallback(() => {
    onApply({
      ...crop,
      enabled: crop.width !== videoWidth || crop.height !== videoHeight || crop.x !== 0 || crop.y !== 0,
    });
    onClose();
  }, [crop, videoWidth, videoHeight, onApply, onClose]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-[700px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crop className="w-5 h-5" />
            Crop Video
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Crop preview */}
          <div className="flex justify-center">
            <CropPreview
              crop={crop}
              onCropChange={handleCropChange}
              videoWidth={videoWidth}
              videoHeight={videoHeight}
              previewImageUrl={previewImageUrl}
            />
          </div>

          {/* Aspect ratio presets */}
          <div className="space-y-2">
            <Label>Aspect Ratio</Label>
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

          {/* Position and size inputs */}
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">X</Label>
              <Input
                type="number"
                value={crop.x}
                onChange={(e) => setCrop((prev) => ({ ...prev, x: Math.max(0, parseInt(e.target.value) || 0) }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Y</Label>
              <Input
                type="number"
                value={crop.y}
                onChange={(e) => setCrop((prev) => ({ ...prev, y: Math.max(0, parseInt(e.target.value) || 0) }))}
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
                  setCrop((prev) => ({
                    ...prev,
                    width: w,
                    height: prev.lockAspectRatio && prev.aspectRatio ? Math.round(w / prev.aspectRatio) : prev.height,
                  }));
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
                  setCrop((prev) => ({
                    ...prev,
                    height: h,
                    width: prev.lockAspectRatio && prev.aspectRatio ? Math.round(h * prev.aspectRatio) : prev.width,
                  }));
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
