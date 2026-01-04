# Editor - Canvas Annotation System

Konva.js-based annotation editor with 9 shape types, undo/redo, and pixel-perfect rendering.

## Structure

```
Editor/
├── EditorCanvas.tsx      # Main canvas (767 lines) - 8+ hooks orchestrated
├── PropertiesPanel.tsx   # Tool-specific property controls
├── Toolbar.tsx           # Tool selection
├── shapes/               # Shape renderers (9 types)
│   ├── ShapeRenderer.tsx # Memoized dispatcher
│   ├── RectShape.tsx
│   ├── ArrowShape.tsx
│   └── ...
├── overlays/             # Canvas overlays (selection, grid)
└── properties/           # Property panel sections
```

## Where to Look

| Task | File | Notes |
|------|------|-------|
| Add new shape type | `shapes/` + `ShapeRenderer.tsx` | Add to dispatcher switch |
| Modify selection | `overlays/SelectionOverlay.tsx` | Handles multi-select |
| Add property control | `properties/` | Tool-specific panels |
| Canvas navigation | Uses `useCanvasNavigation` hook | Zoom/pan logic |
| Drawing logic | Uses `useShapeDrawing` hook | Mouse event handling |

## Patterns

### Hook Orchestration
EditorCanvas composes 8+ hooks - don't add logic directly to component:
```typescript
const navigation = useCanvasNavigation({...});
const drawing = useShapeDrawing({...});
const transform = useShapeTransform({...});
const selection = useSelectionEvents({...});
```

### Shape Rendering (Memoized)
```typescript
// ShapeRenderer.tsx - memoized dispatcher
export const ShapeRenderer = memo(({ shape }: Props) => {
  switch (shape.tool) {
    case 'rect': return <RectShape shape={shape} />;
    case 'arrow': return <ArrowShape shape={shape} />;
    // ...
  }
});
```

### Undo/Redo Integration
```typescript
// From parent component or hook
import { takeSnapshot, commitSnapshot, recordAction } from '@/stores/editorStore';

// Drag operations (start/end)
onDragStart={() => takeSnapshot()}
onDragEnd={() => commitSnapshot()}

// Instant actions
recordAction(() => store.deleteShape(id));
```

### Coordinate Transformation
Canvas uses zoom-aware coordinates:
```typescript
const getCanvasPosition = (screenPos: Point): Point => ({
  x: (screenPos.x - position.x) / zoom,
  y: (screenPos.y - position.y) / zoom,
});
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Add logic to EditorCanvas.tsx | Extract to custom hook |
| Render shapes without memo | Use ShapeRenderer dispatcher |
| Hardcode dimensions | Use constants from `@/constants` |
| Direct state mutation | Use store actions with history |

## Performance

- **Pixel ratio**: Handles HiDPI with `window.devicePixelRatio`
- **Memoization**: Shapes memoized to prevent cascade re-renders
- **Image smoothing**: Disabled at 100% zoom for crisp pixels
- **Lazy rendering**: Only visible shapes rendered
