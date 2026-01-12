import { memo, useCallback, useState, useRef, useEffect } from 'react';
import type { MaskSegment, MaskType } from '../../types';
import { useVideoEditorStore } from '../../stores/videoEditorStore';

interface MaskOverlayProps {
  segments: MaskSegment[];
  currentTimeMs: number;
  previewWidth: number;
  previewHeight: number;
  /** Video element to sample from for pixelation */
  videoElement: HTMLVideoElement | null;
  /** Original video dimensions for proper sampling */
  videoWidth: number;
  videoHeight: number;
  /** Zoom transform style - masks follow the video zoom */
  zoomStyle?: React.CSSProperties;
}

interface MaskItemProps {
  segment: MaskSegment;
  isSelected: boolean;
  previewWidth: number;
  previewHeight: number;
  videoElement: HTMLVideoElement | null;
  videoWidth: number;
  videoHeight: number;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<MaskSegment>) => void;
}

/**
 * Generate CSS mask for feathered (soft) edges.
 * Uses multiple linear gradients to create smooth fade on all edges.
 * Feather value is 0-100, where 0 = hard edge, 100 = maximum softness.
 */
const getFeatherMask = (feather: number, width: number, height: number): React.CSSProperties => {
  if (feather <= 0) return {};

  // Calculate feather size in pixels (percentage of smaller dimension)
  const minDim = Math.min(width, height);
  const featherPx = Math.max(1, (feather / 100) * minDim * 0.5);

  // Create gradient masks for each edge
  // Each gradient goes from transparent at edge to opaque after featherPx
  const maskImage = `
    linear-gradient(to right, transparent, black ${featherPx}px, black calc(100% - ${featherPx}px), transparent),
    linear-gradient(to bottom, transparent, black ${featherPx}px, black calc(100% - ${featherPx}px), transparent)
  `;

  return {
    maskImage,
    WebkitMaskImage: maskImage,
    maskComposite: 'intersect',
    WebkitMaskComposite: 'source-in',
  };
};

/**
 * Get mask style based on type (for blur and solid only)
 */
const getMaskStyle = (maskType: MaskType, intensity: number): React.CSSProperties => {
  switch (maskType) {
    case 'blur':
      return {
        backdropFilter: `blur(${intensity / 5}px)`,
        WebkitBackdropFilter: `blur(${intensity / 5}px)`,
        backgroundColor: `rgba(0, 0, 0, ${intensity / 500})`,
      };
    case 'solid':
      return {
        backgroundColor: 'var(--mask-solid-color, #000000)',
      };
    default:
      return {};
  }
};

/**
 * Canvas-based pixelation component that samples from video
 */
const PixelateCanvas = memo(function PixelateCanvas({
  videoElement,
  videoWidth,
  videoHeight,
  segmentX,
  segmentY,
  segmentWidth,
  segmentHeight,
  previewWidth,
  previewHeight,
  intensity,
  feather,
}: {
  videoElement: HTMLVideoElement | null;
  videoWidth: number;
  videoHeight: number;
  segmentX: number;
  segmentY: number;
  segmentWidth: number;
  segmentHeight: number;
  previewWidth: number;
  previewHeight: number;
  intensity: number;
  feather: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !videoElement || videoWidth === 0 || videoHeight === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Calculate source region in video coordinates
    const srcX = Math.round(segmentX * videoWidth);
    const srcY = Math.round(segmentY * videoHeight);
    const srcW = Math.round(segmentWidth * videoWidth);
    const srcH = Math.round(segmentHeight * videoHeight);

    if (srcW <= 0 || srcH <= 0) return;

    // Canvas size matches display size
    const displayW = Math.round(segmentWidth * previewWidth);
    const displayH = Math.round(segmentHeight * previewHeight);

    if (canvas.width !== displayW || canvas.height !== displayH) {
      canvas.width = displayW;
      canvas.height = displayH;
    }

    // Block size based on intensity (higher intensity = larger blocks = more pixelated)
    const blockSize = Math.max(2, Math.round(intensity / 5));

    // Create small temp canvas for downsampling
    const smallW = Math.max(1, Math.floor(displayW / blockSize));
    const smallH = Math.max(1, Math.floor(displayH / blockSize));

    // Draw video region to small size (downsamples)
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      videoElement,
      srcX, srcY, srcW, srcH,  // Source region
      0, 0, smallW, smallH     // Small destination
    );

    // Draw small canvas back to full size with nearest-neighbor (pixelates)
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      canvas,
      0, 0, smallW, smallH,      // Source (small)
      0, 0, displayW, displayH   // Destination (full size)
    );
  }, [videoElement, videoWidth, videoHeight, segmentX, segmentY, segmentWidth, segmentHeight, previewWidth, previewHeight, intensity]);

  // Continuously update canvas when video plays
  useEffect(() => {
    if (!videoElement) return;

    let animationId: number;

    const updateCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas || videoWidth === 0 || videoHeight === 0) {
        animationId = requestAnimationFrame(updateCanvas);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animationId = requestAnimationFrame(updateCanvas);
        return;
      }

      // Calculate source region in video coordinates
      const srcX = Math.round(segmentX * videoWidth);
      const srcY = Math.round(segmentY * videoHeight);
      const srcW = Math.round(segmentWidth * videoWidth);
      const srcH = Math.round(segmentHeight * videoHeight);

      if (srcW <= 0 || srcH <= 0) {
        animationId = requestAnimationFrame(updateCanvas);
        return;
      }

      const displayW = canvas.width;
      const displayH = canvas.height;

      const blockSize = Math.max(2, Math.round(intensity / 5));
      const smallW = Math.max(1, Math.floor(displayW / blockSize));
      const smallH = Math.max(1, Math.floor(displayH / blockSize));

      // Draw video region to small size (downsamples)
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        videoElement,
        srcX, srcY, srcW, srcH,
        0, 0, smallW, smallH
      );

      // Draw small canvas back to full size with nearest-neighbor
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        canvas,
        0, 0, smallW, smallH,
        0, 0, displayW, displayH
      );

      animationId = requestAnimationFrame(updateCanvas);
    };

    animationId = requestAnimationFrame(updateCanvas);
    return () => cancelAnimationFrame(animationId);
  }, [videoElement, videoWidth, videoHeight, segmentX, segmentY, segmentWidth, segmentHeight, intensity]);

  // Calculate display dimensions for feather
  const displayW = Math.round(segmentWidth * previewWidth);
  const displayH = Math.round(segmentHeight * previewHeight);
  const featherStyle = getFeatherMask(feather, displayW, displayH);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{
        imageRendering: 'pixelated',
        ...featherStyle,
      }}
    />
  );
});

/**
 * Individual mask overlay item with drag/resize handles
 */
const MaskItem = memo(function MaskItem({
  segment,
  isSelected,
  previewWidth,
  previewHeight,
  videoElement,
  videoWidth,
  videoHeight,
  onSelect,
  onUpdate,
}: MaskItemProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br' | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; segX: number; segY: number; segW: number; segH: number } | null>(null);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    onSelect(segment.id);
    setIsDragging(true);
    setDragType(type);

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      segX: segment.x,
      segY: segment.y,
      segW: segment.width,
      segH: segment.height,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;

      const deltaX = (moveEvent.clientX - dragStartRef.current.x) / previewWidth;
      const deltaY = (moveEvent.clientY - dragStartRef.current.y) / previewHeight;

      if (type === 'move') {
        // Move the mask
        const newX = Math.max(0, Math.min(1 - segment.width, dragStartRef.current.segX + deltaX));
        const newY = Math.max(0, Math.min(1 - segment.height, dragStartRef.current.segY + deltaY));
        onUpdate(segment.id, { x: newX, y: newY });
      } else {
        // Resize the mask
        let newX = dragStartRef.current.segX;
        let newY = dragStartRef.current.segY;
        let newW = dragStartRef.current.segW;
        let newH = dragStartRef.current.segH;

        const minSize = 0.02; // Minimum 2% of preview

        switch (type) {
          case 'resize-tl':
            newX = Math.max(0, Math.min(dragStartRef.current.segX + dragStartRef.current.segW - minSize, dragStartRef.current.segX + deltaX));
            newY = Math.max(0, Math.min(dragStartRef.current.segY + dragStartRef.current.segH - minSize, dragStartRef.current.segY + deltaY));
            newW = dragStartRef.current.segX + dragStartRef.current.segW - newX;
            newH = dragStartRef.current.segY + dragStartRef.current.segH - newY;
            break;
          case 'resize-tr':
            newY = Math.max(0, Math.min(dragStartRef.current.segY + dragStartRef.current.segH - minSize, dragStartRef.current.segY + deltaY));
            newW = Math.max(minSize, Math.min(1 - dragStartRef.current.segX, dragStartRef.current.segW + deltaX));
            newH = dragStartRef.current.segY + dragStartRef.current.segH - newY;
            break;
          case 'resize-bl':
            newX = Math.max(0, Math.min(dragStartRef.current.segX + dragStartRef.current.segW - minSize, dragStartRef.current.segX + deltaX));
            newW = dragStartRef.current.segX + dragStartRef.current.segW - newX;
            newH = Math.max(minSize, Math.min(1 - dragStartRef.current.segY, dragStartRef.current.segH + deltaY));
            break;
          case 'resize-br':
            newW = Math.max(minSize, Math.min(1 - dragStartRef.current.segX, dragStartRef.current.segW + deltaX));
            newH = Math.max(minSize, Math.min(1 - dragStartRef.current.segY, dragStartRef.current.segH + deltaY));
            break;
        }

        onUpdate(segment.id, { x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragType(null);
      dragStartRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [segment, previewWidth, previewHeight, onSelect, onUpdate]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [segment.id, onSelect]);

  // Calculate pixel positions
  const left = segment.x * previewWidth;
  const top = segment.y * previewHeight;
  const width = segment.width * previewWidth;
  const height = segment.height * previewHeight;

  const isPixelate = segment.maskType === 'pixelate';

  // Get feather (soft edge) styling - applies to blur and solid masks
  // Pixelate handles feather internally via the canvas
  const featherStyle = !isPixelate ? getFeatherMask(segment.feather, width, height) : {};

  // Show gizmo (outline, handles) only when selected
  const showGizmo = isSelected;

  return (
    <div
      className="absolute transition-shadow"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        cursor: isDragging ? (dragType === 'move' ? 'grabbing' : 'nwse-resize') : 'pointer',
      }}
      onClick={handleClick}
    >
      {/* Mask effect layer - separate from gizmo outline for proper feathering */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{
          ...(isPixelate ? {} : getMaskStyle(segment.maskType, segment.intensity)),
          '--mask-solid-color': segment.color,
          ...featherStyle,
        } as React.CSSProperties}
      >
        {/* Canvas-based pixelation for pixelate type */}
        {isPixelate && (
          <PixelateCanvas
            videoElement={videoElement}
            videoWidth={videoWidth}
            videoHeight={videoHeight}
            segmentX={segment.x}
            segmentY={segment.y}
            segmentWidth={segment.width}
            segmentHeight={segment.height}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            intensity={segment.intensity}
            feather={segment.feather}
          />
        )}
      </div>

      {/* Gizmo dashed outline - only when selected */}
      {showGizmo && (
        <div
          className="absolute inset-0 border-2 border-dashed border-purple-500 pointer-events-none z-10"
          style={{ borderRadius: 2 }}
        />
      )}

      {/* Move handle (center) */}
      <div
        className="absolute inset-0 cursor-grab active:cursor-grabbing z-10"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
      />

      {/* Corner resize handles - only when selected */}
      {showGizmo && (
        <>
          {/* Top-left */}
          <div
            className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nwse-resize shadow-md hover:scale-125 transition-transform z-20"
            onMouseDown={(e) => handleMouseDown(e, 'resize-tl')}
          />
          {/* Top-right */}
          <div
            className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nesw-resize shadow-md hover:scale-125 transition-transform z-20"
            onMouseDown={(e) => handleMouseDown(e, 'resize-tr')}
          />
          {/* Bottom-left */}
          <div
            className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nesw-resize shadow-md hover:scale-125 transition-transform z-20"
            onMouseDown={(e) => handleMouseDown(e, 'resize-bl')}
          />
          {/* Bottom-right */}
          <div
            className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nwse-resize shadow-md hover:scale-125 transition-transform z-20"
            onMouseDown={(e) => handleMouseDown(e, 'resize-br')}
          />

          {/* Info badge */}
          <div className="absolute -top-6 left-0 bg-purple-600 text-white text-[10px] px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap z-20">
            {segment.maskType === 'blur' ? 'Blur' : segment.maskType === 'pixelate' ? 'Pixelate' : 'Solid'} {segment.intensity}%
          </div>
        </>
      )}
    </div>
  );
});

/**
 * MaskOverlay - Renders mask overlays on the video preview.
 * Shows only masks that are active at the current time.
 * Uses canvas-based rendering for pixelation to properly sample from video.
 */
export const MaskOverlay = memo(function MaskOverlay({
  segments,
  currentTimeMs,
  previewWidth,
  previewHeight,
  videoElement,
  videoWidth,
  videoHeight,
  zoomStyle,
}: MaskOverlayProps) {
  const selectedMaskSegmentId = useVideoEditorStore((s) => s.selectedMaskSegmentId);
  const selectMaskSegment = useVideoEditorStore((s) => s.selectMaskSegment);
  const updateMaskSegment = useVideoEditorStore((s) => s.updateMaskSegment);

  // Filter segments that are active at current time
  const activeSegments = segments.filter(
    (seg) => currentTimeMs >= seg.startMs && currentTimeMs <= seg.endMs
  );

  // Handle click on overlay container to deselect
  const handleContainerClick = useCallback(() => {
    selectMaskSegment(null);
  }, [selectMaskSegment]);

  if (activeSegments.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={zoomStyle}
      onClick={handleContainerClick}
    >
      {activeSegments.map((segment) => (
        <div key={segment.id} className="pointer-events-auto">
          <MaskItem
            segment={segment}
            isSelected={segment.id === selectedMaskSegmentId}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            videoElement={videoElement}
            videoWidth={videoWidth}
            videoHeight={videoHeight}
            onSelect={selectMaskSegment}
            onUpdate={updateMaskSegment}
          />
        </div>
      ))}
    </div>
  );
});
