/**
 * VideoEditorView - Re-export from refactored location
 *
 * This file maintains backwards compatibility with existing imports.
 * The actual implementation is now in ./VideoEditor/index.tsx
 *
 * @see ./VideoEditor/index.tsx for the main component
 * @see ./VideoEditor/VideoEditorToolbar.tsx for the toolbar
 * @see ./VideoEditor/VideoEditorSidebar.tsx for the sidebar
 * @see ./VideoEditor/VideoEditorPreview.tsx for the preview
 * @see ./VideoEditor/VideoEditorTimeline.tsx for the timeline
 */

export {
  VideoEditorView,
  type VideoEditorViewRef,
  type VideoEditorViewProps,
  // Subcomponents
  VideoEditorToolbar,
  VideoEditorSidebar,
  VideoEditorPreview,
  VideoEditorTimeline,
  // Config components
  PositionGrid,
  ZoomRegionConfig,
  MaskSegmentConfig,
  TextSegmentConfig,
} from './VideoEditor';
