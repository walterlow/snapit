# Video Editor Store

This document describes the architecture and state management of the video editor store, which uses Zustand with a slice-based pattern for managing editor state.

## Architecture Overview

The video editor store is composed of six feature slices, each responsible for a specific domain of functionality. The slices are combined using Zustand's slice pattern to create a unified store.

```
VideoEditorStore
    |
    +-- playbackSlice     (playback control)
    +-- timelineSlice     (UI/interaction state)
    +-- segmentsSlice     (timeline segments)
    +-- exportSlice       (export operations)
    +-- projectSlice      (project lifecycle)
    +-- gpuEditorSlice    (GPU rendering)
```

### Store Composition

The store is created in `index.ts` by composing all slices:

```typescript
export const useVideoEditorStore = create<VideoEditorState>()(
  devtools(
    (...a) => ({
      ...createPlaybackSlice(...a),
      ...createTimelineSlice(...a),
      ...createSegmentsSlice(...a),
      ...createExportSlice(...a),
      ...createProjectSlice(...a),
      ...createGPUEditorSlice(...a),
    }),
    { name: 'VideoEditorStore' }
  )
);
```

## Playback State Machine

The playback system has three primary states with transitions driven by user actions and GPU editor events.

```
                    +------------------+
                    |                  |
                    v                  |
    +-------+   togglePlayback()   +-------+
    | Idle  | ------------------> | Playing|
    +-------+ <------------------ +-------+
        |       togglePlayback()      |
        |       setIsPlaying(false)   |
        |                             |
        |  setCurrentTime()           |  setCurrentTime()
        |  gpuSeek()                  |  gpuSeek()
        v                             v
    +-------+                     +-------+
    | Seeking|                    | Seeking|
    +-------+                     +-------+
        |                             |
        | seek completes              | seek completes
        v                             v
    +-------+                     +-------+
    | Idle  |                     | Playing|
    +-------+                     +-------+
```

### State Descriptions

| State | Description |
|-------|-------------|
| **Idle** | Video is paused. `isPlaying = false`. User can seek or start playback. |
| **Playing** | Video is playing. `isPlaying = true`. Frames render continuously. |
| **Seeking** | Transitional state during seek operations. Time position updates. |

### Key Actions

- `togglePlayback()` - Toggle between playing and paused
- `setCurrentTime(ms)` - Seek to specific time (clamped to duration)
- `setIsPlaying(bool)` - Direct playback state control

## Slice Descriptions

### playbackSlice.ts

Manages video playback state and basic transport controls.

**State:**
| Field | Type | Description |
|-------|------|-------------|
| `currentTimeMs` | `number` | Current playhead position in milliseconds |
| `currentFrame` | `number` | Current frame number |
| `isPlaying` | `boolean` | Whether video is currently playing |
| `renderedFrame` | `RenderedFrame \| null` | Latest rendered frame data |

**Actions:**
- `setCurrentTime(timeMs)` - Seek to time, clamped to project duration
- `togglePlayback()` - Toggle play/pause state
- `setIsPlaying(playing)` - Set playback state directly

---

### timelineSlice.ts

Manages timeline UI state including zoom, scroll, track visibility, and drag interactions.

**State:**
| Field | Type | Description |
|-------|------|-------------|
| `timelineZoom` | `number` | Zoom level (0.01-0.1, default 0.05 = 50px/sec) |
| `timelineScrollLeft` | `number` | Horizontal scroll position |
| `timelineContainerWidth` | `number` | Container width for calculations |
| `trackVisibility` | `TrackVisibility` | Which tracks are visible |
| `isDraggingPlayhead` | `boolean` | Playhead drag state |
| `isDraggingZoomRegion` | `boolean` | Zoom region drag state |
| `draggedZoomEdge` | `DragEdge` | Which edge being dragged |
| `isDraggingSceneSegment` | `boolean` | Scene segment drag state |
| `isDraggingMaskSegment` | `boolean` | Mask segment drag state |
| `isDraggingTextSegment` | `boolean` | Text segment drag state |
| `previewTimeMs` | `number \| null` | Preview time during hover |
| `hoveredTrack` | `HoveredTrack` | Currently hovered track |
| `splitMode` | `boolean` | Whether split tool is active |

**Actions:**
- `setTimelineZoom(zoom)` - Set zoom level (clamped 0.01-0.1)
- `fitTimelineToWindow()` - Auto-fit timeline to container
- `toggleTrackVisibility(track)` - Toggle track visibility
- `setDragging*(dragging, edge?)` - Drag state setters for each segment type
- `setSplitMode(enabled)` - Toggle split tool

---

### segmentsSlice.ts

Manages all timeline segments: zoom regions, text overlays, masks, scenes, and webcam visibility.

**State:**
| Field | Type | Description |
|-------|------|-------------|
| `selectedZoomRegionId` | `string \| null` | Selected zoom region |
| `selectedTextSegmentId` | `string \| null` | Selected text segment |
| `selectedMaskSegmentId` | `string \| null` | Selected mask segment |
| `selectedSceneSegmentId` | `string \| null` | Selected scene segment |
| `selectedWebcamSegmentIndex` | `number \| null` | Selected webcam segment |

**Actions by Segment Type:**

Each segment type has a consistent set of CRUD operations:

| Segment Type | Select | Add | Update | Delete |
|--------------|--------|-----|--------|--------|
| Zoom Region | `selectZoomRegion(id)` | `addZoomRegion(region)` | `updateZoomRegion(id, updates)` | `deleteZoomRegion(id)` |
| Text | `selectTextSegment(id)` | `addTextSegment(segment)` | `updateTextSegment(id, updates)` | `deleteTextSegment(id)` |
| Mask | `selectMaskSegment(id)` | `addMaskSegment(segment)` | `updateMaskSegment(id, updates)` | `deleteMaskSegment(id)` |
| Scene | `selectSceneSegment(id)` | `addSceneSegment(segment)` | `updateSceneSegment(id, updates)` | `deleteSceneSegment(id)` |
| Webcam | `selectWebcamSegment(idx)` | `addWebcamSegment(segment)` | `updateWebcamSegment(idx, updates)` | `deleteWebcamSegment(idx)` |

**Additional Actions:**
- `splitZoomRegionAtPlayhead()` - Split selected zoom region at current time
- `deleteSelectedZoomRegion()` - Delete currently selected zoom region
- `toggleWebcamAtTime(timeMs)` - Toggle webcam visibility at time
- `updateWebcamConfig(updates)` - Update webcam configuration
- `updateCursorConfig(updates)` - Update cursor configuration
- `updateAudioConfig(updates)` - Update audio configuration

**Selection Behavior:**
Selecting any segment type clears selections in all other types (mutual exclusivity).

---

### exportSlice.ts

Manages video export operations and auto-zoom generation.

**State:**
| Field | Type | Description |
|-------|------|-------------|
| `isExporting` | `boolean` | Whether export is in progress |
| `exportProgress` | `ExportProgress \| null` | Current export progress |
| `isGeneratingAutoZoom` | `boolean` | Whether auto-zoom generation is running |

**Actions:**
- `updateExportConfig(updates)` - Update export settings (format, quality, fps)
- `exportVideo(outputPath)` - Start video export to specified path
- `setExportProgress(progress)` - Update export progress state
- `cancelExport()` - Cancel current export operation
- `generateAutoZoom(config?)` - Generate zoom regions from cursor data

**Export State Machine:**

```
    +-------+    exportVideo()    +-----------+
    | Idle  | -----------------> | Exporting |
    +-------+ <----------------- +-----------+
                 success/fail         |
                                      | setExportProgress()
                                      v
                                +-----------+
                                | Progress  |
                                | Updates   |
                                +-----------+
```

---

### projectSlice.ts

Manages project lifecycle: loading, saving, and cleanup.

**State:**
| Field | Type | Description |
|-------|------|-------------|
| `project` | `VideoProject \| null` | Current loaded project |
| `cursorRecording` | `CursorRecording \| null` | Loaded cursor movement data |
| `isSaving` | `boolean` | Whether save is in progress |
| `lastSavedAt` | `string \| null` | ISO timestamp of last save |

**Actions:**
- `setProject(project)` - Load a project (resets editor state)
- `loadCursorData(path)` - Load cursor recording from file
- `saveProject()` - Save current project to disk
- `clearEditor()` - Reset all editor state to initial values

**Side Effects:**
- `setProject()` stores video path in sessionStorage for F5 refresh persistence
- `setProject()` auto-loads cursor data if path exists in project
- `clearEditor()` destroys GPU editor instance

---

### gpuEditorSlice.ts

Manages GPU-accelerated video rendering via Tauri backend.

**State:**
| Field | Type | Description |
|-------|------|-------------|
| `editorInstanceId` | `string \| null` | Active GPU editor instance ID |
| `editorInfo` | `EditorInstanceInfo \| null` | Editor instance metadata |
| `isInitializingEditor` | `boolean` | Whether editor is initializing |

**Actions:**
- `initializeGPUEditor(project)` - Create GPU editor instance
- `destroyGPUEditor()` - Clean up GPU editor instance
- `handlePlaybackEvent(event)` - Process playback events from backend
- `renderFrame(timestampMs)` - Request specific frame render
- `gpuPlay()` - Start GPU playback
- `gpuPause()` - Pause GPU playback
- `gpuSeek(timestampMs)` - Seek GPU editor to time

**GPU Editor Lifecycle:**

```
                initializeGPUEditor()
    +-------+ ----------------------> +---------+
    | None  |                         | Active  |
    +-------+ <---------------------- +---------+
                destroyGPUEditor()         |
                clearEditor()              |
                                           | gpuPlay/Pause/Seek
                                           v
                                     +-----------+
                                     | Rendering |
                                     +-----------+
```

## Slice Interactions

### Project Load Flow

```
setProject(project)
    |
    +-> Resets playback state (currentTimeMs, isPlaying)
    +-> Clears segment selections
    +-> Auto-loads cursor data --> loadCursorData()
    +-> Stores path in sessionStorage
```

### Playback with GPU Editor

```
User clicks play
    |
    v
togglePlayback() --> gpuPlay()
    |                    |
    |                    v
    |               Backend starts playback
    |                    |
    +<-------------------+
    |        handlePlaybackEvent()
    v
State updates (currentFrame, currentTimeMs, isPlaying)
```

### Segment Selection Mutual Exclusivity

When any segment is selected, all other segment selections clear:

```
selectZoomRegion(id)
    |
    +-> selectedZoomRegionId = id
    +-> selectedSceneSegmentId = null
    +-> selectedTextSegmentId = null
    +-> selectedMaskSegmentId = null
    +-> selectedWebcamSegmentIndex = null
```

### Export Flow

```
exportVideo(path)
    |
    +-> isExporting = true
    +-> invoke('export_video', ...)
    |       |
    |       +-> Backend emits progress events
    |               |
    |               v
    |       setExportProgress(progress)
    |
    +-> Success: isExporting = false, return result
    +-> Failure: isExporting = false, throw error
```

## Type Definitions

Key types are defined in `types.ts`:

- `VideoEditorState` - Combined type of all slices
- `SliceCreator<T>` - Type helper for creating slices
- `TrackVisibility` - Track visibility configuration
- `HoveredTrack` - Union type for track hover states
- `DragEdge` - Edge types for drag operations

External types imported from `../../types`:
- `VideoProject` - Complete project data structure
- `ZoomRegion`, `TextSegment`, `MaskSegment`, `SceneSegment` - Segment types
- `ExportProgress`, `ExportResult` - Export-related types
- `EditorInstanceInfo`, `PlaybackEvent`, `RenderedFrame` - GPU editor types

## Utility Functions

Exported from `index.ts`:

- `formatTimecode(ms)` - Format as `MM:SS:FF` (30fps)
- `formatTimeSimple(ms)` - Format as `M:SS`
- `generateZoomRegionId()` - Generate unique zoom region ID
- `sanitizeProjectForSave(project)` - Ensure ms values are integers for Rust backend
- `createVideoEditorStore()` - Factory for isolated store instances (placeholder)

## Constants

- `DEFAULT_TIMELINE_ZOOM = 0.05` - Default zoom level (50px per second)
