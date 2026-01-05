# Hooks - Custom React Hooks

35 custom hooks extracting complex logic from components.

## Structure

```
hooks/
├── useEditorActions.ts       # Save/export logic
├── useCanvasNavigation.ts    # Zoom/pan (579 lines)
├── useShapeDrawing.ts        # Mouse → shape creation
├── useShapeTransform.ts      # Resize/rotate handlers
├── useSelectionEvents.ts     # Multi-select logic
├── useCursorInterpolation.ts # Video cursor smoothing (548 lines)
├── useTheme.ts               # OS theme sync
├── useKeyboardShortcuts.ts   # Global hotkeys
├── useCaptureActions.ts      # Library actions
├── useUpdater.ts             # Auto-update check
└── *.test.ts                 # Colocated tests
```

## Where to Look

| Task | Hook | Notes |
|------|------|-------|
| Canvas zoom/pan | `useCanvasNavigation` | Wheel, pinch, keyboard |
| Drawing shapes | `useShapeDrawing` | Mouse events → shapes |
| Save/export | `useEditorActions` | Returns `{ handleSave, handleCopy }` |
| Keyboard shortcuts | `useKeyboardShortcuts` | Global registration |
| Theme switching | `useTheme` | Syncs with OS preference |

## Patterns

### Return Object Pattern
```typescript
export function useEditorActions() {
  const [isSaving, setIsSaving] = useState(false);
  
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await invoke('save_capture', {...});
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { isSaving, handleSave, handleCopy, handleSaveAs };
}
```

### Ref-Based Imperative Logic
```typescript
export function useCanvasNavigation(options: Options) {
  const positionRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  
  // Imperative updates avoid re-renders
  const pan = useCallback((dx: number, dy: number) => {
    positionRef.current.x += dx;
    positionRef.current.y += dy;
    options.onPositionChange?.(positionRef.current);
  }, []);

  return { pan, zoom, reset, positionRef, zoomRef };
}
```

### Cleanup Pattern
```typescript
export function useKeyboardShortcuts() {
  useEffect(() => {
    const unregister = registerShortcut('Ctrl+S', handleSave);
    
    return () => {
      unregister(); // Always cleanup
    };
  }, [handleSave]);
}
```

### Store Integration
```typescript
export function useCaptureActions() {
  // Select only needed state to minimize re-renders
  const selectedIds = useCaptureStore(s => s.selectedIds);
  const deleteCaptures = useCaptureStore(s => s.deleteCaptures);
  
  const handleDelete = useCallback(async () => {
    await deleteCaptures(selectedIds);
  }, [selectedIds, deleteCaptures]);

  return { handleDelete, selectedIds };
}
```

## Testing Pattern
```typescript
// hooks/useCaptureActions.test.ts
import { renderHook, act } from '@testing-library/react';
import { useCaptureActions } from './useCaptureActions';

describe('useCaptureActions', () => {
  it('returns stable function references', () => {
    const { result, rerender } = renderHook(() => useCaptureActions());
    const firstHandle = result.current.handleDelete;
    rerender();
    expect(result.current.handleDelete).toBe(firstHandle);
  });
});
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Put hook logic in components | Extract to dedicated hook |
| Return unstable references | Wrap callbacks in `useCallback` |
| Subscribe to entire store | Use selectors: `useStore(s => s.field)` |
| Skip cleanup in effects | Always return cleanup function |
| Create hooks without `use` prefix | Follow naming convention |

## Composition

Large components compose multiple hooks:
```typescript
// EditorCanvas.tsx composes 8+ hooks
function EditorCanvas() {
  const navigation = useCanvasNavigation({...});
  const drawing = useShapeDrawing({...});
  const transform = useShapeTransform({...});
  const selection = useSelectionEvents({...});
  const persistence = useEditorPersistence({...});
  // Component only handles rendering
}
```
