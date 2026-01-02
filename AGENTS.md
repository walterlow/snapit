# AGENTS.md - SnapIt Development Guide

> For agentic coding assistants working on this Tauri + React + Rust codebase.

## Quick Reference

### Commands

```bash
# Development
npm run dev              # Start Vite dev server (frontend only)
npm run tauri dev        # Run full Tauri app in development

# Build
npm run build            # Build frontend (tsc + vite)
npm run tauri build      # Build production app

# Testing
npm run test             # Run tests in watch mode
npm run test:run         # Run tests once
npm run test -- -t "pattern"           # Run tests matching pattern
npm run test -- src/stores/editorStore # Run single test file
npm run test:coverage    # Run with coverage

# Linting & Type Checking
npm run lint             # ESLint on src/
npm run lint:fix         # ESLint with auto-fix
npm run typecheck        # TypeScript check (tsc --noEmit)

# Rust
cargo test --lib         # Run Rust tests + generate TS types
cargo clippy             # Rust linting
cargo fmt                # Format Rust code
```

### Pre-commit Hook

Husky runs `lint-staged` on commit, which runs ESLint --fix on staged `*.ts,*.tsx` files.

---

## Project Structure

```
snapit/
├── src/                    # React frontend (TypeScript)
│   ├── components/         # UI components (shadcn/ui pattern)
│   ├── hooks/              # Custom React hooks
│   ├── stores/             # Zustand state stores
│   ├── types/              # TypeScript types
│   │   └── generated/      # AUTO-GENERATED from Rust - DO NOT EDIT
│   ├── utils/              # Utility functions
│   ├── views/              # Main view components
│   └── windows/            # Entry points for secondary windows
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands/       # Tauri command handlers
│   │   ├── rendering/      # GPU rendering (wgpu)
│   │   ├── error.rs        # Central error types
│   │   └── lib.rs          # App setup + tray
│   └── capabilities/       # Tauri capability configs
└── public/                 # Static assets
```

---

## Code Style Guidelines

### TypeScript

**Imports**: Order by external → internal → types, use `@/` alias for src paths.

```typescript
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEditorStore } from '@/stores/editorStore';
import type { CanvasShape } from '@/types';
```

**Naming**:
- Components: PascalCase (`CaptureToolbar.tsx`)
- Hooks: `use` prefix, camelCase (`useTheme.ts`)
- Stores: camelCase with `Store` suffix (`editorStore.ts`)
- Constants: SCREAMING_SNAKE_CASE (`STORAGE.HISTORY_LIMIT`)
- Types/Interfaces: PascalCase (`EditorState`, `CanvasShape`)

**Type Safety**:
- NEVER use `as any`, `@ts-ignore`, `@ts-expect-error`
- Prefix unused params with `_` (`_event`, `_unused`)
- Use type guards for discriminated unions

**State Management**: Zustand with devtools middleware.

```typescript
export const useEditorStore = create<EditorState>()(
  devtools(
    (set, get) => ({
      // state and actions
    }),
    { name: 'EditorStore', enabled: process.env.NODE_ENV === 'development' }
  )
);
```

### Rust

**Error Handling**: Use `SnapItError` from `src-tauri/src/error.rs`. Always use `thiserror` for new error variants.

```rust
use crate::error::{SnapItError, SnapItResult};

#[tauri::command]
pub async fn my_command() -> SnapItResult<MyType> {
    // ...
    Err(SnapItError::CaptureError("reason".to_string()))
}
```

**Type Generation (ts-rs)**: Rust is the source of truth for shared types.

```rust
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MyType {
    pub some_field: String,
    #[ts(type = "number")]  // u64 → number (JSON compat)
    pub large_number: u64,
}
```

After adding/modifying Rust types: `cargo test --lib` to regenerate TypeScript.

**Naming**: snake_case for functions/variables, PascalCase for types, SCREAMING_SNAKE_CASE for constants.

### CSS / Styling

**Tailwind CSS 4** with shadcn/ui components (Radix UI primitives).

**CRITICAL - Shadows**: NEVER use `box-shadow` for external shadows in Tauri windows.

```css
/* WRONG - gets clipped in transparent windows */
box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);

/* CORRECT - use filter */
filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5));

/* box-shadow OK for inset only */
box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
```

---

## Key Patterns

### Tauri Commands

Frontend calls Rust via `invoke`:

```typescript
import { invoke } from '@tauri-apps/api/core';

const result = await invoke<FastCaptureResult>('capture_fullscreen_fast');
```

Rust command signature:

```rust
#[tauri::command]
pub async fn capture_fullscreen_fast() -> SnapItResult<FastCaptureResult> { ... }
```

### Window Capabilities

New windows must be added to `src-tauri/capabilities/desktop.json`:

```json
{
  "windows": ["main", "library", "capture-toolbar", "new-window-name"]
}
```

### React 19.2+ Activity

Use `<Activity>` to preserve component state when switching views:

```tsx
import { Activity } from 'react';

<Activity mode={view === 'library' ? 'visible' : 'hidden'}>
  <CaptureLibrary />
</Activity>
```

### Undo/Redo Pattern

Use snapshot-based history from editorStore:

```typescript
import { takeSnapshot, commitSnapshot, recordAction } from '@/stores/editorStore';

// For drag operations
onDragStart={() => takeSnapshot()}
onDragEnd={() => commitSnapshot()}

// For instant actions
recordAction(() => {
  useEditorStore.getState().setShapes([...]);
});
```

---

## Testing

**Framework**: Vitest with jsdom, React Testing Library.

**File naming**: `*.test.ts` or `*.test.tsx` in same directory as source.

**Test structure**:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('featureName', () => {
  beforeEach(() => {
    // Reset state
  });

  it('should do something specific', () => {
    // Arrange, Act, Assert
  });
});
```

**Mocks**: Place in `src/test/mocks/`. Tauri APIs are mocked in `src/test/setup.ts`.

---

## Important Notes

1. **Simplicity first** - Make the simplest change possible. No backward compatibility unless asked.

2. **Code readability** - Happy to make bigger changes to achieve better readability.

3. **Generated types** - Never edit `src/types/generated/*`. Run `cargo test --lib` to regenerate.

4. **FFmpeg/Rust for media** - Use ffmpeg-sidecar or Rust for media processing, not JavaScript.

5. **shadcn/ui docs** - Component reference: https://ui.shadcn.com/docs

6. **Path aliases** - Use `@/` for imports from `src/` (configured in tsconfig.json).

---

## Debugging Tips

- **Window events not working**: Check `desktop.json` capabilities
- **Type mismatch Rust↔TS**: Run `cargo test --lib` to regenerate types
- **Shadows clipped**: Use `filter: drop-shadow()` not `box-shadow`
- **State not persisting**: Check if using correct store and devtools is enabled
