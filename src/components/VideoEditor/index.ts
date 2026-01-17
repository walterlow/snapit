// VideoEditor components - export all for easy importing
export { VideoPreview } from './VideoPreview';
export { VideoTimeline } from './VideoTimeline';
export { TimelineRuler } from './TimelineRuler';
export { WebcamTrack } from './WebcamTrack';

// Track components - re-export from tracks folder
export {
  ZoomTrackContent,
  SceneTrack,
  SceneTrackContent,
  MaskTrackContent,
  TextTrackContent,
  BaseSegmentItem,
  DefaultSegmentContent,
  useSegmentDrag,
  type BaseSegment,
  type BaseSegmentItemProps,
  type DragEdge,
} from './tracks';
