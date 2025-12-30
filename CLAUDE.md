# SnapIt Development Notes

We want the simplest change possible. We don 't care about migration. Code
readability matters most, and we 're happy to make bigger changes to achieve it. No backward compatiblity unless asked for it.

Uses shadcn/ui components with Radix UI primitives. Component docs: https://ui.shadcn.com/docs

## Tauri Capabilities

When creating new windows or debugging event issues:

1. **Check `src-tauri/capabilities/desktop.json`** - New windows must be added to the `windows` array to receive events
2. If you see `event.listen not allowed on window "X"` error, add the window name to the capabilities
3. Wildcard patterns like `overlay_*` match multiple windows

## ts-rs: Single Source of Truth for Rust ↔ TypeScript Types

We use [ts-rs](https://github.com/Aleph-Alpha/ts-rs) to generate TypeScript types from Rust. This eliminates manual type sync issues.

### How it works

1. **Rust is the source of truth** - Types are defined in Rust with `#[derive(TS)]`
2. **TypeScript types are generated** - Running `cargo test` generates `.ts` files in `src/types/generated/`
3. **Re-exported from index** - `src/types/index.ts` re-exports generated types

### Adding new shared types

```rust
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MyNewType {
    pub some_field: String,
    #[ts(type = "number")]  // Override u64 -> number (JSON doesn't support bigint)
    pub large_number: u64,
}
```

Then:
1. Run `cargo test --lib` to generate the TypeScript file
2. Add export to `src/types/generated/index.ts`
3. Re-export from `src/types/index.ts` if needed publicly

### Important notes

- Use `#[ts(type = "number")]` for `u64` fields - JSON serializes as number, not bigint
- For tagged enums, both `#[serde(tag = "...")]` and `#[serde(rename_all = "...")]` are respected
- Generated files have "Do not edit" comment - changes will be overwritten
- serde attributes are still required - ts-rs reads them for type generation, serde uses them for runtime serialization

## React 19.2+ Activity Component

We use `<Activity>` from React 19.2+ to preserve component state when switching views. This is NOT an error - it's a legitimate React feature.

```tsx
import { Activity } from 'react';

// Keeps component mounted but hidden, preserving state
<Activity mode={view === 'library' ? 'visible' : 'hidden'}>
  <CaptureLibrary />
</Activity>
```

- `mode="visible"` - Component renders normally
- `mode="hidden"` - Component is hidden (`display: none`), effects unmounted, but state preserved
- Used in `App.tsx` to keep Library/Editor mounted when switching views

## Shadows: Use CSS Filter, NOT box-shadow

**NEVER use `box-shadow` for external shadows.** Always use `filter: drop-shadow()` instead.

### Why?
- `box-shadow` gets clipped at window/element boundaries in Tauri transparent windows
- `filter: drop-shadow()` renders in a separate compositing layer, avoiding clipping issues

### Pattern
```css
/* WRONG - will get clipped */
box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);

/* CORRECT - use filter for external shadows */
filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5)) drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3));

/* box-shadow is OK for INSET shadows only */
box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
```

### Checklist when adding shadows
1. Remove any `shadow-*` Tailwind classes from shadcn/ui components
2. Use `filter: drop-shadow()` in CSS for external shadows
3. Only use `box-shadow` for inset effects
