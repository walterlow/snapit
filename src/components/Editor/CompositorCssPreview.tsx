import React from 'react';
import type { CompositorSettings } from '../../types';

interface CompositionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CompositorCssPreviewProps {
  /** Ref to attach to the preview div for coordinated transforms */
  previewRef?: React.RefObject<HTMLDivElement | null>;
  /** Compositor settings from store */
  settings: CompositorSettings;
  /** Computed composition box position/size in screen coordinates */
  compositionBox: CompositionBox;
  /** Current zoom level */
  zoom: number;
  /** Background style computed from settings */
  backgroundStyle: React.CSSProperties;
}

/**
 * Renders the CSS-based compositor preview background.
 * This sits behind the Konva canvas and provides a smooth preview
 * of the compositor background during pan/zoom operations.
 */
export const CompositorCssPreview: React.FC<CompositorCssPreviewProps> = ({
  previewRef,
  settings,
  compositionBox,
  zoom,
  backgroundStyle,
}) => {
  if (!settings.enabled) return null;

  // Shadow position is simply the padding offset within the composition box
  // Content sits at (padding, padding) within the compositor area
  const scaledPadding = settings.padding * zoom;
  const contentWidth = compositionBox.width - scaledPadding * 2;
  const contentHeight = compositionBox.height - scaledPadding * 2;
  const intensity = settings.shadowIntensity;

  return (
    <div
      ref={previewRef}
      className="absolute pointer-events-none"
      style={{
        left: compositionBox.left,
        top: compositionBox.top,
        width: compositionBox.width,
        height: compositionBox.height,
        zIndex: 0,
        willChange: 'transform',
        contain: 'layout style paint',
        ...backgroundStyle,
      }}
    >
      {settings.shadowIntensity > 0 && (
        <div
          style={{
            position: 'absolute',
            left: scaledPadding,
            top: scaledPadding,
            width: contentWidth,
            height: contentHeight,
            borderRadius: settings.borderRadius * zoom,
            boxShadow: [
              `0 ${2 * intensity}px ${10 * intensity}px rgba(0,0,0,${0.15 * intensity})`,
              `0 ${8 * intensity}px ${30 * intensity}px rgba(0,0,0,${0.25 * intensity})`,
              `0 ${16 * intensity}px ${60 * intensity}px rgba(0,0,0,${0.35 * intensity})`,
            ].join(', '),
          }}
        />
      )}
    </div>
  );
};

export default CompositorCssPreview;
