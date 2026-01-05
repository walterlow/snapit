# VideoEditor - Video Editing UI

Complex video editor with GPU-accelerated preview, multi-track timeline, and export pipeline.

## Structure

```
VideoEditor/
├── GPUVideoPreview.tsx     # wgpu-rendered preview (582 lines)
├── VideoTimeline.tsx       # Multi-track timeline (730 lines)
├── VideoPreview.tsx        # Fallback CPU preview
├── ZoomTrack.tsx           # Zoom region timeline
├── SceneTrack.tsx          # Scene segment editing
├── TextSegmentTrack.tsx    # Text overlay timeline
├── Playhead.tsx            # Timeline cursor
├── PreviewScrubber.tsx     # Quick preview on hover
└── ExportProgress.tsx      # Export status overlay
```

## Where to Look

| Task | File | Notes |
|------|------|-------|
| Preview rendering | `GPUVideoPreview.tsx` | Calls Rust GPU editor |
| Timeline behavior | `VideoTimeline.tsx` | Zoom, drag, selection |
| Add track type | Create new `*Track.tsx` | Follow ZoomTrack pattern |
| Export UI | `ExportProgress.tsx` | Progress from store |
| Playback controls | `VideoEditorView.tsx` | Parent view handles |

## Patterns

### GPU Editor Integration
Preview uses Rust GPU renderer via store:
```typescript
// videoEditorStore handles GPU instance
const { editorInstanceId, renderFrame } = useVideoEditorStore();

// Request frame render
await invoke('editor_render_frame', { 
  instanceId: editorInstanceId, 
  timestampMs: currentTimeMs 
});
```

### Timeline Zoom Constraints
```typescript
// Store enforces limits
setTimelineZoom: (zoom) => set({ 
  timelineZoom: Math.max(0.01, Math.min(0.5, zoom)) 
})
```

### Imperative Handle Pattern
```typescript
// VideoEditorView exposes controls to parent
export interface VideoEditorViewRef {
  togglePlayback: () => void;
  seekToStart: () => void;
  exportVideo: () => void;
}

const VideoEditorView = forwardRef<VideoEditorViewRef>((props, ref) => {
  useImperativeHandle(ref, () => ({
    togglePlayback: () => { /* ... */ },
  }));
});
```

### Memoized Sub-components
Timeline uses 8+ memoized components for 60fps performance:
```typescript
const MemoizedPlayhead = memo(Playhead);
const MemoizedZoomTrack = memo(ZoomTrack);
// ... prevents re-renders during playback
```

## Store Integration

Primary store: `videoEditorStore.ts` (957 lines, 150+ actions)

Key state groups:
- **Project**: VideoProject, timeline, zoom regions
- **Playback**: currentTimeMs, isPlaying, playbackRate
- **GPU**: editorInstanceId, editorInfo
- **Export**: exportProgress, exportError

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Call GPU commands directly | Use videoEditorStore actions |
| Skip memoization on tracks | Wrap in `memo()` for playback perf |
| Hardcode timeline values | Use store constraints |
| Block UI during export | Use async + progress events |

## Performance Notes

- **60fps playback**: Heavy memoization on all timeline components
- **GPU rendering**: wgpu compositor in Rust, not JS
- **Prefetching**: Decoder prefetches frames for smooth scrubbing
- **Auto-save**: Debounced, non-blocking background saves
