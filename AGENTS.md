# AGENTS.md - SnapIt Development Guide

> For agentic coding assistants working on this Tauri + React + Rust codebase.

**Generated:** 2026-01-05 | **Commit:** 949207b | **Branch:** videoeditor

## Overview

Screen capture & annotation tool for Windows. Tauri 2 + React 19 + Rust + wgpu GPU rendering.

## Structure

```
snapit/
├── src/                        # React frontend (TypeScript)
│   ├── components/
│   │   ├── Editor/             # Canvas annotation editor (Konva) [AGENTS.md]
│   │   ├── VideoEditor/        # Video editing UI + timeline [AGENTS.md]
│   │   ├── Library/            # Capture library with virtualization
│   │   ├── CaptureToolbar/     # Recording controls
│   │   └── ui/                 # shadcn/ui components (24)
│   ├── hooks/                  # 35 custom hooks [AGENTS.md]
│   ├── stores/                 # 12 Zustand stores [AGENTS.md]
│   ├── types/generated/        # AUTO-GENERATED - DO NOT EDIT
│   ├── windows/                # Secondary window entry points
│   └── constants/              # All magic numbers/strings
├── src-tauri/
│   ├── src/
│   │   ├── commands/           # 70+ Tauri handlers [AGENTS.md]
│   │   ├── rendering/          # wgpu GPU pipeline [AGENTS.md]
│   │   ├── error.rs            # SnapItError + SnapItResult
│   │   └── lib.rs              # App setup, tray, plugins
│   └── capabilities/           # Window permissions
└── public/                     # Static assets
```

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Add annotation tool | `src/components/Editor/shapes/` | Follow ShapeRenderer pattern |
| Add Tauri command | `src-tauri/src/commands/` | Return `SnapItResult<T>` |
| Add shared type | Rust file with `#[derive(TS)]` | Run `cargo test --lib` |
| Add UI component | `src/components/ui/` | Use shadcn/ui CLI |
| Add store | `src/stores/` | Use devtools middleware |
| Add hook | `src/hooks/` | Extract from component logic |
| Video editing | `src/components/VideoEditor/` | Uses GPU via Rust |
| Screen capture | `src-tauri/src/commands/capture/` | xcap + BitBlt fallback |

## Commands

```bash
# Development
npm run tauri dev        # Full app with hot reload
npm run dev              # Vite only (no Tauri)

# Build
npm run tauri build      # Production app
cargo test --lib         # Regenerate TS types from Rust

# Quality
npm run test:run         # Vitest once
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
cargo clippy             # Rust linting
```

## Conventions

### TypeScript

**Imports**: External → internal (`@/`) → types
```typescript
import { useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import type { CanvasShape } from '@/types';
```

**Naming**: Components=PascalCase, hooks=`use*`, stores=`*Store`, constants=SCREAMING_SNAKE

**No magic values**: Extract to `src/constants/`
```typescript
// WRONG: if (history.length > 50)
// CORRECT:
import { STORAGE } from '@/constants';
if (history.length > STORAGE.HISTORY_LIMIT)
```

### Rust

**Error handling**: Always use `SnapItResult<T>` and `SnapItError` variants
```rust
use crate::error::{SnapItError, SnapItResult};

#[tauri::command]
pub async fn my_command() -> SnapItResult<MyType> {
    Err(SnapItError::CaptureError("reason".into()))
}
```

**Type generation**: Rust is source of truth
```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MyType { /* fields */ }
```

### CSS

**CRITICAL - Shadows in Tauri**: NEVER use `box-shadow` for external shadows
```css
/* WRONG - clipped in transparent windows */
box-shadow: 0 4px 16px rgba(0,0,0,0.4);

/* CORRECT */
filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
```

## Anti-Patterns

| Forbidden | Why |
|-----------|-----|
| `as any`, `@ts-ignore`, `@ts-expect-error` | Breaks type safety |
| Edit `src/types/generated/*` | Overwritten by `cargo test --lib` |
| `box-shadow` for external shadows | Clipped in Tauri windows |
| Hard-coded numbers/strings | Use `src/constants/` |
| Empty catch blocks | Handle or propagate errors |

## Key Patterns

### Tauri IPC
```typescript
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<FastCaptureResult>('capture_fullscreen_fast');
```

### Undo/Redo (Editor)
```typescript
import { takeSnapshot, commitSnapshot, recordAction } from '@/stores/editorStore';

// Drag operations
onDragStart={() => takeSnapshot()}
onDragEnd={() => commitSnapshot()}

// Instant actions
recordAction(() => useEditorStore.getState().setShapes([...]));
```

### React 19 Activity
```tsx
<Activity mode={view === 'library' ? 'visible' : 'hidden'}>
  <CaptureLibrary />
</Activity>
```

### Window Capabilities
New windows must be added to `src-tauri/capabilities/desktop.json`:
```json
{ "windows": ["main", "library", "capture-toolbar", "new-window-name"] }
```

## Testing

**Framework**: Vitest + jsdom + React Testing Library

**Mocks**: `src/test/mocks/tauri.ts` mocks all Tauri APIs
```typescript
import { setInvokeResponse } from '@/test/mocks/tauri';
setInvokeResponse('command_name', mockResult);
```

**Pattern**: Tests colocated with source (`*.test.ts`)

## Debugging

| Issue | Check |
|-------|-------|
| Window events broken | `desktop.json` capabilities |
| Type mismatch Rust↔TS | Run `cargo test --lib` |
| Shadows clipped | Use `filter: drop-shadow()` |
| State not persisting | Correct store + devtools enabled |

## Video Recording Gotchas

### Region Capture Coordinates
When using scap (or any capture API) with a crop region on multi-monitor setups:
- **Screen coordinates** (e.g., `x=3840` on second monitor) must be converted to **monitor-local coordinates** (e.g., `x=0`)
- The capture API operates in monitor-local space, not screen space
- Cursor events are captured in screen space and normalized to the crop region
- If coordinates aren't converted, the cursor overlay will be offset from the video

```rust
// WRONG: Passing screen coordinates directly
let crop = Area { origin: Point { x: 3840.0, y: 0.0 }, ... };

// CORRECT: Convert to monitor-local coordinates
let local_x = screen_x - monitor_offset_x;
let local_y = screen_y - monitor_offset_y;
let crop = Area { origin: Point { x: local_x as f64, y: local_y as f64 }, ... };
```

### Cursor Overlay Zoom
The cursor overlay must apply the same CSS transform as the video for zoom to work:
- Video uses `useZoomPreview` hook for zoom transforms
- CursorOverlay and ClickHighlightOverlay must also use `useZoomPreview`
- Pass `zoomRegions` prop to overlay components


## Logging

Backend (Rust) logs are written to:
- **Windows**: `%APPDATA%/com.snapit.app/logs/` (e.g., `C:\Users\<user>\AppData\Roaming\com.snapit.app\logs\`)
- Logs include timestamps and are rotated automatically
- Use `log::info!`, `log::debug!`, `log::warn!`, `log::error!` in Rust code
- Both console output and file logging are enabled via `tauri-plugin-log`

## Subdirectory Guides

- [`src/components/Editor/AGENTS.md`](src/components/Editor/AGENTS.md) - Canvas annotation patterns
- [`src/components/VideoEditor/AGENTS.md`](src/components/VideoEditor/AGENTS.md) - Video editing UI
- [`src/stores/AGENTS.md`](src/stores/AGENTS.md) - Zustand state management
- [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) - Custom hook conventions
- [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) - Tauri command handlers
- [`src-tauri/src/rendering/AGENTS.md`](src-tauri/src/rendering/AGENTS.md) - GPU rendering pipeline
