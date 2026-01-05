# Stores - Zustand State Management

12 Zustand stores with devtools, snapshot-based history, and optimistic updates.

## Structure

```
stores/
├── editorStore.ts          # Canvas shapes + undo/redo (736 lines)
├── captureStore.ts         # Library captures + caching (737 lines)
├── videoEditorStore.ts     # Video project + GPU editor (957 lines)
├── settingsStore.ts        # App preferences
├── captureSettingsStore.ts # Capture format/quality
├── videoRecordingStore.ts  # Recording state
├── webcamSettingsStore.ts  # Webcam config
├── audioInputStore.ts      # Mic selection
├── editorHistory.ts        # History management helper
└── *.test.ts               # Colocated tests
```

## Where to Look

| Task | Store | Notes |
|------|-------|-------|
| Canvas shapes/tools | `editorStore` | Has undo/redo |
| Library CRUD | `captureStore` | Optimistic updates |
| Video editing | `videoEditorStore` | GPU editor lifecycle |
| User preferences | `settingsStore` | Persisted |
| Recording state | `videoRecordingStore` | Shared across windows |

## Patterns

### Store Creation (Standard)
```typescript
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export const useMyStore = create<MyState>()(
  devtools(
    (set, get) => ({
      // State
      items: [],
      
      // Actions
      addItem: (item) => set(
        { items: [...get().items, item] },
        false,
        'addItem' // Action name for devtools
      ),
    }),
    { name: 'MyStore', enabled: process.env.NODE_ENV === 'development' }
  )
);
```

### Undo/Redo (editorStore only)
```typescript
import { takeSnapshot, commitSnapshot, recordAction } from '@/stores/editorStore';

// For drag operations (reversible)
onDragStart={() => takeSnapshot()}
onDragEnd={() => commitSnapshot()}

// For instant actions
recordAction(() => {
  useEditorStore.getState().deleteShape(id);
});

// Undo/redo
useEditorStore.getState().undo();
useEditorStore.getState().redo();
```

### Optimistic Updates (captureStore pattern)
```typescript
const saveCapture = async (data) => {
  const tempId = `temp-${Date.now()}`;
  const placeholder = createPlaceholder(tempId);
  
  // 1. Optimistic update
  set({ captures: [placeholder, ...get().captures] });
  
  try {
    // 2. Actual save
    const result = await invoke('save_capture', { data });
    
    // 3. Replace placeholder
    set({ 
      captures: get().captures.map(c => 
        c.id === tempId ? result : c
      ) 
    });
  } catch {
    // 4. Rollback on error
    set({ 
      captures: get().captures.filter(c => c.id !== tempId) 
    });
  }
};
```

### Cross-Store Communication
```typescript
// Access other stores from actions
import { useCaptureStore } from './captureStore';

// Inside videoEditorStore action:
const capture = useCaptureStore.getState().getCapture(id);
```

## Testing Pattern
```typescript
// stores/myStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useMyStore } from './myStore';

describe('myStore', () => {
  beforeEach(() => {
    useMyStore.setState(initialState); // Reset between tests
  });

  it('adds item', () => {
    useMyStore.getState().addItem({ id: '1' });
    expect(useMyStore.getState().items).toHaveLength(1);
  });
});
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Create store without devtools | Always wrap with `devtools()` |
| Mutate state directly | Use `set()` with new objects |
| Skip action names | Add 3rd arg to `set()` for devtools |
| Access store in render | Use selector: `useStore(s => s.field)` |

## Session Persistence Keys

Stores use consistent keys for browser persistence:
```typescript
// From constants
STORAGE.SESSION_VIEW_KEY = 'snapit_current_view';
STORAGE.SESSION_PROJECT_ID_KEY = 'snapit_current_project_id';
STORAGE.SESSION_VIDEO_PROJECT_PATH_KEY = 'snapit_video_project_path';
```
