# Code Quality Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve code quality across the SnapIt codebase by addressing large files, type safety issues, test coverage gaps, and code duplication.

**Architecture:** Incrementally refactor oversized components into smaller, focused modules while maintaining backwards compatibility. Add comprehensive test coverage for critical paths. Eliminate `any` types and consolidate shared patterns.

**Tech Stack:** TypeScript 5.8, React 19, Vitest, Zustand 5, ESLint 9

---

## Phase 1: Type Safety Audit

### Task 1.1: Audit and Fix `any` Types in Stores

**Files:**
- Modify: `src/stores/videoEditorStore.ts`
- Modify: `src/stores/editorStore.ts`
- Modify: `src/stores/captureStore.ts`

**Step 1: Find all `any` usages in stores**

Run: `bun run grep -n "any" src/stores/*.ts | grep -v ".test.ts"`

Document each instance and determine proper type.

**Step 2: Create missing type definitions**

Add any missing types to `src/types/index.ts`:

```typescript
// Example - actual types depend on audit findings
export interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}
```

**Step 3: Replace `any` with proper types**

For each `any` found, replace with the appropriate type. Run typecheck after each file:

Run: `bun run typecheck`
Expected: No new errors

**Step 4: Commit**

```bash
git add src/stores/*.ts src/types/index.ts
git commit -m "fix(types): replace any types in stores with proper types"
```

---

### Task 1.2: Audit and Fix `any` Types in Hooks

**Files:**
- Modify: `src/hooks/usePlaybackEngine.ts`
- Modify: `src/hooks/useCursorInterpolation.ts`
- Modify: `src/hooks/useCanvasNavigation.ts`
- Modify: `src/hooks/useShapeDrawing.ts`

**Step 1: Find all `any` usages in hooks**

Run: `bun run grep -n "any" src/hooks/*.ts | grep -v ".test.ts"`

**Step 2: Fix each `any` type**

Replace with proper types. For complex callback types, use generics:

```typescript
// Before
const handleCallback = (data: any) => { ... }

// After
const handleCallback = <T extends Record<string, unknown>>(data: T) => { ... }
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors

**Step 4: Commit**

```bash
git add src/hooks/*.ts
git commit -m "fix(types): replace any types in hooks with proper types"
```

---

### Task 1.3: Audit and Fix `any` Types in Components

**Files:**
- Modify: `src/components/VideoEditor/*.tsx`
- Modify: `src/components/Editor/*.tsx`
- Modify: `src/components/CaptureToolbar/*.tsx`

**Step 1: Find all `any` usages in components**

Run: `bun run grep -rn "any" src/components/ --include="*.tsx" | grep -v ".test.tsx" | grep -v "node_modules"`

**Step 2: Fix component prop types**

Ensure all component props have proper interfaces:

```typescript
// Before
function MyComponent({ data }: { data: any }) { ... }

// After
interface MyComponentProps {
  data: SpecificDataType;
}
function MyComponent({ data }: MyComponentProps) { ... }
```

**Step 3: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/
git commit -m "fix(types): replace any types in components with proper types"
```

---

### Task 1.4: Update ESLint to Error on `any`

**Files:**
- Modify: `eslint.config.js`

**Step 1: Update ESLint rule**

Change from warn to error:

```javascript
// In eslint.config.js, find the rule:
'@typescript-eslint/no-explicit-any': 'warn',

// Change to:
'@typescript-eslint/no-explicit-any': 'error',
```

**Step 2: Run lint to verify no violations**

Run: `bun run lint`
Expected: PASS with no `any` errors

**Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "chore(lint): upgrade no-explicit-any from warn to error"
```

---

## Phase 2: Split Large Components

### Task 2.1: Split videoEditorStore.ts into Feature Modules

**Files:**
- Modify: `src/stores/videoEditorStore.ts` (1,291 lines)
- Create: `src/stores/videoEditor/playbackSlice.ts`
- Create: `src/stores/videoEditor/timelineSlice.ts`
- Create: `src/stores/videoEditor/exportSlice.ts`
- Create: `src/stores/videoEditor/annotationsSlice.ts`
- Create: `src/stores/videoEditor/index.ts`

**Step 1: Analyze store structure**

Read videoEditorStore.ts and identify logical groupings:
- Playback state (play/pause, currentTime, seeking)
- Timeline state (tracks, clips, zoom)
- Export state (format, quality, progress)
- Annotations state (shapes, selections)

**Step 2: Create playbackSlice.ts**

```typescript
// src/stores/videoEditor/playbackSlice.ts
import { StateCreator } from 'zustand';
import type { VideoEditorState } from './types';

export interface PlaybackSlice {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  seek: (time: number) => void;
}

export const createPlaybackSlice: StateCreator<
  VideoEditorState,
  [],
  [],
  PlaybackSlice
> = (set, get) => ({
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  seek: (time) => {
    set({ currentTime: time, isPlaying: false });
  },
});
```

**Step 3: Create remaining slices**

Create timelineSlice.ts, exportSlice.ts, annotationsSlice.ts following same pattern.

**Step 4: Create combined store**

```typescript
// src/stores/videoEditor/index.ts
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createPlaybackSlice, PlaybackSlice } from './playbackSlice';
import { createTimelineSlice, TimelineSlice } from './timelineSlice';
import { createExportSlice, ExportSlice } from './exportSlice';
import { createAnnotationsSlice, AnnotationsSlice } from './annotationsSlice';

export type VideoEditorState = PlaybackSlice & TimelineSlice & ExportSlice & AnnotationsSlice;

export const useVideoEditorStore = create<VideoEditorState>()(
  devtools(
    (...a) => ({
      ...createPlaybackSlice(...a),
      ...createTimelineSlice(...a),
      ...createExportSlice(...a),
      ...createAnnotationsSlice(...a),
    }),
    { name: 'video-editor-store' }
  )
);
```

**Step 5: Update imports in consuming files**

Search and replace imports:

```typescript
// Before
import { useVideoEditorStore } from '@/stores/videoEditorStore';

// After (same API, different file location)
import { useVideoEditorStore } from '@/stores/videoEditor';
```

**Step 6: Run tests**

Run: `bun run test:run`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/stores/videoEditor/ src/stores/videoEditorStore.ts
git commit -m "refactor(stores): split videoEditorStore into feature slices"
```

---

### Task 2.2: Extract VideoEditorView Subcomponents

**Files:**
- Modify: `src/views/VideoEditorView.tsx` (1,836 lines)
- Create: `src/views/VideoEditor/VideoEditorToolbar.tsx`
- Create: `src/views/VideoEditor/VideoEditorSidebar.tsx`
- Create: `src/views/VideoEditor/VideoEditorPreview.tsx`
- Create: `src/views/VideoEditor/VideoEditorTimeline.tsx`
- Create: `src/views/VideoEditor/index.tsx`

**Step 1: Identify component boundaries**

Read VideoEditorView.tsx and identify:
- Toolbar section (top controls)
- Sidebar section (properties panel)
- Preview section (video preview)
- Timeline section (track editor)

**Step 2: Extract VideoEditorToolbar**

```typescript
// src/views/VideoEditor/VideoEditorToolbar.tsx
import { useVideoEditorStore } from '@/stores/videoEditor';

interface VideoEditorToolbarProps {
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

export function VideoEditorToolbar({ onExport, onUndo, onRedo }: VideoEditorToolbarProps) {
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);
  // ... extract toolbar JSX from VideoEditorView
}
```

**Step 3: Extract remaining components**

Create VideoEditorSidebar, VideoEditorPreview, VideoEditorTimeline following same pattern.

**Step 4: Create orchestrating component**

```typescript
// src/views/VideoEditor/index.tsx
import { VideoEditorToolbar } from './VideoEditorToolbar';
import { VideoEditorSidebar } from './VideoEditorSidebar';
import { VideoEditorPreview } from './VideoEditorPreview';
import { VideoEditorTimeline } from './VideoEditorTimeline';

export function VideoEditorView() {
  // Keep only orchestration logic here
  return (
    <div className="flex flex-col h-full">
      <VideoEditorToolbar />
      <div className="flex flex-1">
        <VideoEditorPreview />
        <VideoEditorSidebar />
      </div>
      <VideoEditorTimeline />
    </div>
  );
}
```

**Step 5: Update routing/imports**

Update any imports pointing to the old location.

**Step 6: Run app and verify functionality**

Run: `bun run tauri dev`
Verify: Video editor functions correctly

**Step 7: Commit**

```bash
git add src/views/VideoEditor/ src/views/VideoEditorView.tsx
git commit -m "refactor(views): split VideoEditorView into focused subcomponents"
```

---

### Task 2.3: Extract GPUVideoPreview Helpers

**Files:**
- Modify: `src/components/VideoEditor/GPUVideoPreview.tsx` (1,281 lines)
- Create: `src/components/VideoEditor/gpu/useGPURenderer.ts`
- Create: `src/components/VideoEditor/gpu/useFrameBuffer.ts`
- Create: `src/components/VideoEditor/gpu/GPUCanvas.tsx`

**Step 1: Extract GPU rendering hook**

```typescript
// src/components/VideoEditor/gpu/useGPURenderer.ts
export function useGPURenderer(canvasRef: RefObject<HTMLCanvasElement>) {
  // Extract GPU initialization and rendering logic
}
```

**Step 2: Extract frame buffer hook**

```typescript
// src/components/VideoEditor/gpu/useFrameBuffer.ts
export function useFrameBuffer(maxFrames: number) {
  // Extract frame caching and prefetching logic
}
```

**Step 3: Create GPUCanvas component**

```typescript
// src/components/VideoEditor/gpu/GPUCanvas.tsx
export function GPUCanvas({ width, height, onReady }: GPUCanvasProps) {
  // Extract canvas setup and resize handling
}
```

**Step 4: Simplify GPUVideoPreview**

Refactor GPUVideoPreview.tsx to compose the extracted pieces.

**Step 5: Run tests**

Run: `bun run test:run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/components/VideoEditor/gpu/ src/components/VideoEditor/GPUVideoPreview.tsx
git commit -m "refactor(gpu): extract GPUVideoPreview helpers into focused modules"
```

---

## Phase 3: Test Coverage

### Task 3.1: Add Tests for videoEditorStore

**Files:**
- Create: `src/stores/videoEditor/playbackSlice.test.ts`
- Create: `src/stores/videoEditor/timelineSlice.test.ts`

**Step 1: Write playback slice tests**

```typescript
// src/stores/videoEditor/playbackSlice.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useVideoEditorStore } from './index';

describe('playbackSlice', () => {
  beforeEach(() => {
    useVideoEditorStore.setState({
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
    });
  });

  it('should set isPlaying', () => {
    useVideoEditorStore.getState().setIsPlaying(true);
    expect(useVideoEditorStore.getState().isPlaying).toBe(true);
  });

  it('should seek to time and pause', () => {
    useVideoEditorStore.getState().setIsPlaying(true);
    useVideoEditorStore.getState().seek(5.5);

    const state = useVideoEditorStore.getState();
    expect(state.currentTime).toBe(5.5);
    expect(state.isPlaying).toBe(false);
  });
});
```

**Step 2: Run tests**

Run: `bun run test:run src/stores/videoEditor/`
Expected: PASS

**Step 3: Write timeline slice tests**

Add tests for track management, clip operations, zoom.

**Step 4: Run full test suite**

Run: `bun run test:run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/stores/videoEditor/*.test.ts
git commit -m "test(stores): add tests for video editor store slices"
```

---

### Task 3.2: Add Tests for VideoTimeline Component

**Files:**
- Create: `src/components/VideoEditor/VideoTimeline.test.tsx`

**Step 1: Write component tests**

```typescript
// src/components/VideoEditor/VideoTimeline.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VideoTimeline } from './VideoTimeline';

describe('VideoTimeline', () => {
  it('should render timeline tracks', () => {
    render(<VideoTimeline />);
    expect(screen.getByTestId('timeline-container')).toBeInTheDocument();
  });

  it('should handle scrubbing', () => {
    const onSeek = vi.fn();
    render(<VideoTimeline onSeek={onSeek} />);

    const ruler = screen.getByTestId('timeline-ruler');
    fireEvent.mouseDown(ruler, { clientX: 100 });

    expect(onSeek).toHaveBeenCalled();
  });

  it('should zoom timeline with scroll', () => {
    render(<VideoTimeline />);

    const container = screen.getByTestId('timeline-container');
    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true });

    // Verify zoom state changed
  });
});
```

**Step 2: Add test data-testid attributes**

Add necessary `data-testid` attributes to VideoTimeline.tsx for testing.

**Step 3: Run tests**

Run: `bun run test:run src/components/VideoEditor/VideoTimeline.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/VideoEditor/VideoTimeline.tsx src/components/VideoEditor/VideoTimeline.test.tsx
git commit -m "test(components): add tests for VideoTimeline component"
```

---

### Task 3.3: Add Tests for CropDialog Component

**Files:**
- Create: `src/components/VideoEditor/CropDialog.test.tsx`

**Step 1: Write component tests**

```typescript
// src/components/VideoEditor/CropDialog.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CropDialog } from './CropDialog';

describe('CropDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onApply: vi.fn(),
    videoWidth: 1920,
    videoHeight: 1080,
  };

  it('should render when open', () => {
    render(<CropDialog {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('should call onApply with crop values', () => {
    render(<CropDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Apply'));

    expect(defaultProps.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      })
    );
  });

  it('should maintain aspect ratio when locked', () => {
    render(<CropDialog {...defaultProps} />);

    // Toggle aspect ratio lock
    fireEvent.click(screen.getByTestId('aspect-lock-toggle'));

    // Adjust width and verify height changes proportionally
  });
});
```

**Step 2: Run tests**

Run: `bun run test:run src/components/VideoEditor/CropDialog.test.tsx`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/VideoEditor/CropDialog.tsx src/components/VideoEditor/CropDialog.test.tsx
git commit -m "test(components): add tests for CropDialog component"
```

---

### Task 3.4: Add Integration Tests for Video Export Flow

**Files:**
- Create: `src/test/integration/videoExport.test.ts`

**Step 1: Write integration test**

```typescript
// src/test/integration/videoExport.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setInvokeResponse } from '@/test/mocks/tauri';
import { useVideoEditorStore } from '@/stores/videoEditor';

describe('Video Export Flow', () => {
  beforeEach(() => {
    // Reset store state
    useVideoEditorStore.getState().reset();

    // Mock Tauri commands
    setInvokeResponse('export_video', { success: true, path: '/output/video.mp4' });
    setInvokeResponse('get_export_progress', { progress: 0.5 });
  });

  it('should complete full export workflow', async () => {
    const store = useVideoEditorStore.getState();

    // 1. Start export
    await store.startExport({
      format: 'mp4',
      quality: 'high',
      outputPath: '/output/video.mp4',
    });

    expect(store.isExporting).toBe(true);

    // 2. Verify progress updates
    await store.updateExportProgress();
    expect(store.exportProgress).toBe(0.5);

    // 3. Complete export
    setInvokeResponse('get_export_progress', { progress: 1.0, complete: true });
    await store.updateExportProgress();

    expect(store.isExporting).toBe(false);
    expect(store.exportProgress).toBe(1.0);
  });
});
```

**Step 2: Run integration tests**

Run: `bun run test:run src/test/integration/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/test/integration/videoExport.test.ts
git commit -m "test(integration): add video export flow integration tests"
```

---

## Phase 4: Code Deduplication

### Task 4.1: Create Base Track Component

**Files:**
- Create: `src/components/VideoEditor/tracks/BaseTrack.tsx`
- Modify: `src/components/VideoEditor/tracks/SceneTrack.tsx`
- Modify: `src/components/VideoEditor/tracks/MaskTrack.tsx`
- Modify: `src/components/VideoEditor/tracks/TextTrack.tsx`
- Modify: `src/components/VideoEditor/tracks/ZoomTrack.tsx`

**Step 1: Identify shared logic**

Read all track components and identify:
- Common props (track, onSelect, onDrag)
- Shared drag handling
- Common rendering patterns
- Shared keyboard shortcuts

**Step 2: Create BaseTrack component**

```typescript
// src/components/VideoEditor/tracks/BaseTrack.tsx
import { useCallback, useRef } from 'react';

export interface BaseTrackProps<T> {
  track: T;
  isSelected: boolean;
  onSelect: (track: T) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrag: (deltaX: number) => void;
  renderContent: (track: T) => React.ReactNode;
}

export function BaseTrack<T extends { id: string }>({
  track,
  isSelected,
  onSelect,
  onDragStart,
  onDragEnd,
  onDrag,
  renderContent,
}: BaseTrackProps<T>) {
  const dragRef = useRef({ startX: 0, isDragging: false });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    onSelect(track);
    dragRef.current = { startX: e.clientX, isDragging: true };
    onDragStart();
  }, [track, onSelect, onDragStart]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current.isDragging) return;
    const deltaX = e.clientX - dragRef.current.startX;
    dragRef.current.startX = e.clientX;
    onDrag(deltaX);
  }, [onDrag]);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current.isDragging) {
      dragRef.current.isDragging = false;
      onDragEnd();
    }
  }, [onDragEnd]);

  return (
    <div
      className={`track ${isSelected ? 'track--selected' : ''}`}
      onMouseDown={handleMouseDown}
      data-testid={`track-${track.id}`}
    >
      {renderContent(track)}
    </div>
  );
}
```

**Step 3: Refactor SceneTrack to use BaseTrack**

```typescript
// src/components/VideoEditor/tracks/SceneTrack.tsx
import { BaseTrack } from './BaseTrack';
import type { SceneTrackData } from '@/types';

export function SceneTrack(props: SceneTrackProps) {
  const renderContent = (track: SceneTrackData) => (
    <>
      <SceneThumbnail scene={track.scene} />
      <SceneLabel>{track.label}</SceneLabel>
    </>
  );

  return <BaseTrack {...props} renderContent={renderContent} />;
}
```

**Step 4: Refactor remaining track components**

Apply same pattern to MaskTrack, TextTrack, ZoomTrack.

**Step 5: Run tests**

Run: `bun run test:run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/components/VideoEditor/tracks/
git commit -m "refactor(tracks): extract shared logic into BaseTrack component"
```

---

### Task 4.2: Consolidate Logger Usage

**Files:**
- Modify: Multiple files with `console.log/warn/error`
- Modify: `src/utils/logger.ts` (if needed)

**Step 1: Find all console.* usages**

Run: `bun run grep -rn "console\." src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v ".test."`

**Step 2: Replace with logger**

```typescript
// Before
console.log('Loading video:', videoId);
console.error('Failed to render frame:', error);

// After
import { logger } from '@/utils/logger';
logger.info('Loading video:', { videoId });
logger.error('Failed to render frame:', { error });
```

**Step 3: Verify no console.* remains**

Run: `bun run grep -rn "console\." src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v ".test."`
Expected: No matches (or only intentional debug code)

**Step 4: Commit**

```bash
git add src/
git commit -m "refactor(logging): replace console.* with centralized logger"
```

---

## Phase 5: Error Handling

### Task 5.1: Add GPU Error Boundary

**Files:**
- Create: `src/components/VideoEditor/GPUErrorBoundary.tsx`
- Modify: `src/components/VideoEditor/GPUVideoPreview.tsx`

**Step 1: Create GPU error boundary**

```typescript
// src/components/VideoEditor/GPUErrorBoundary.tsx
import { Component, ReactNode } from 'react';
import { logger } from '@/utils/logger';

interface Props {
  children: ReactNode;
  fallback: ReactNode;
  onError?: (error: Error) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class GPUErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('GPU rendering error:', { error, componentStack: errorInfo.componentStack });
    this.props.onError?.(error);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="gpu-error">
          <p>GPU rendering failed</p>
          <button onClick={this.handleRetry}>Retry</button>
          {this.props.fallback}
        </div>
      );
    }

    return this.props.children;
  }
}
```

**Step 2: Wrap GPUVideoPreview**

```typescript
// In parent component
<GPUErrorBoundary fallback={<SoftwareRenderer />}>
  <GPUVideoPreview />
</GPUErrorBoundary>
```

**Step 3: Run tests**

Run: `bun run test:run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/components/VideoEditor/GPUErrorBoundary.tsx src/components/VideoEditor/GPUVideoPreview.tsx
git commit -m "feat(errors): add GPU error boundary with recovery"
```

---

### Task 5.2: Add Device Lost Recovery

**Files:**
- Modify: `src/components/VideoEditor/gpu/useGPURenderer.ts`

**Step 1: Add device lost handler**

```typescript
// In useGPURenderer.ts
useEffect(() => {
  if (!device) return;

  const handleLost = async (info: GPUDeviceLostInfo) => {
    logger.warn('GPU device lost:', { reason: info.reason, message: info.message });

    if (info.reason === 'destroyed') {
      // Intentional destruction, no recovery needed
      return;
    }

    // Attempt recovery
    try {
      const newDevice = await requestGPUDevice();
      setDevice(newDevice);
      logger.info('GPU device recovered');
    } catch (error) {
      logger.error('GPU recovery failed:', { error });
      onDeviceLost?.();
    }
  };

  device.lost.then(handleLost);
}, [device, onDeviceLost]);
```

**Step 2: Run tests**

Run: `bun run test:run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/components/VideoEditor/gpu/useGPURenderer.ts
git commit -m "feat(gpu): add device lost recovery mechanism"
```

---

## Phase 6: Documentation

### Task 6.1: Add JSDoc to Complex Utilities

**Files:**
- Modify: `src/utils/canvasGeometry.ts`
- Modify: `src/utils/hotkeyManager.ts`

**Step 1: Document canvasGeometry functions**

```typescript
// src/utils/canvasGeometry.ts

/**
 * Converts screen coordinates to canvas coordinates, accounting for
 * pan offset and zoom level.
 *
 * @param screenX - X coordinate in screen/viewport space
 * @param screenY - Y coordinate in screen/viewport space
 * @param transform - Current canvas transform (pan + zoom)
 * @returns Point in canvas coordinate space
 *
 * @example
 * const canvasPoint = screenToCanvas(event.clientX, event.clientY, transform);
 */
export function screenToCanvas(
  screenX: number,
  screenY: number,
  transform: CanvasTransform
): Point {
  // implementation
}
```

**Step 2: Document hotkeyManager**

Add JSDoc comments to all public functions in hotkeyManager.ts.

**Step 3: Verify docs render correctly**

Run: `bun run typecheck`
Expected: No errors with JSDoc

**Step 4: Commit**

```bash
git add src/utils/canvasGeometry.ts src/utils/hotkeyManager.ts
git commit -m "docs(utils): add JSDoc documentation to complex utilities"
```

---

### Task 6.2: Document Store State Machines

**Files:**
- Create: `src/stores/videoEditor/README.md`

**Step 1: Create store documentation**

```markdown
# Video Editor Store

## State Machine

The video editor uses a state machine pattern for playback:

```
┌─────────┐   play()   ┌─────────┐
│  IDLE   │ ─────────> │ PLAYING │
└─────────┘            └─────────┘
     ^                      │
     │      pause()         │
     └──────────────────────┘

┌─────────┐   seek()   ┌─────────┐
│  ANY    │ ─────────> │ SEEKING │
└─────────┘            └─────────┘
```

## Slices

- **playbackSlice**: Play/pause, seek, playback rate
- **timelineSlice**: Track management, zoom, scroll
- **exportSlice**: Export settings, progress
- **annotationsSlice**: Shape selection, transforms
```

**Step 2: Commit**

```bash
git add src/stores/videoEditor/README.md
git commit -m "docs(stores): add state machine documentation for video editor"
```

---

## Summary

This plan addresses the critical code quality issues identified:

1. **Type Safety (Phase 1)**: Eliminate all `any` types and enforce stricter linting
2. **Large Files (Phase 2)**: Split 3 largest files into manageable modules
3. **Test Coverage (Phase 3)**: Add tests for critical untested components
4. **Code Duplication (Phase 4)**: Extract shared patterns into reusable components
5. **Error Handling (Phase 5)**: Add GPU error boundaries and recovery
6. **Documentation (Phase 6)**: Add JSDoc and architecture docs

**Total Tasks:** 14 tasks across 6 phases
**Estimated Commits:** 14 focused commits

Each phase can be completed independently, allowing for incremental improvement while maintaining a working codebase.
