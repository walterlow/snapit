/* tslint:disable */
/* eslint-disable */

export class WasmTextRenderer {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a new text renderer attached to a canvas element
   */
  static create(canvas_id: string): Promise<WasmTextRenderer>;
  /**
   * Render text segments at the given time
   */
  render(segments_js: any, time_sec: number): void;
  /**
   * Resize the renderer when canvas size changes
   */
  resize(width: number, height: number): void;
  /**
   * Load a font from raw TTF/OTF data.
   * Returns JSON with actual registered family name and weight: {"family": "...", "weight": 400}
   */
  load_font(font_data: Uint8Array): any;
}

/**
 * Initialize panic hook and logging for better error messages
 */
export function init(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmtextrenderer_free: (a: number, b: number) => void;
  readonly init: () => void;
  readonly wasmtextrenderer_create: (a: number, b: number) => any;
  readonly wasmtextrenderer_load_font: (a: number, b: number, c: number) => [number, number, number];
  readonly wasmtextrenderer_render: (a: number, b: any, c: number) => [number, number];
  readonly wasmtextrenderer_resize: (a: number, b: number, c: number) => void;
  readonly wasm_bindgen__convert__closures_____invoke__h83f5efd394ae5b03: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen__closure__destroy__h79f33c3c0d0850dd: (a: number, b: number) => void;
  readonly wasm_bindgen__convert__closures_____invoke__h181afe9263d2d602: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
