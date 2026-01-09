/**
 * Standard Windows cursor SVG definitions with hotspot coordinates.
 * 
 * These SVGs are used as the PRIMARY cursor rendering method.
 * When cursor_shape is detected, we use SVG; bitmap is only fallback.
 * Hotspot coordinates are normalized (0-1) relative to cursor size.
 * 
 * Source: Cap (https://github.com/cap-so/cap)
 */

import type { WindowsCursorShape } from '../types';

export interface CursorDefinition {
  /** Path to SVG file relative to public/ */
  svg: string;
  /** Hotspot X coordinate (0-1, normalized) */
  hotspotX: number;
  /** Hotspot Y coordinate (0-1, normalized) */
  hotspotY: number;
}

/**
 * SVG cursor definitions with hotspots.
 * Keys match the WindowsCursorShape enum from Rust (camelCase).
 * Hotspot values from Cap project.
 */
export const WINDOWS_CURSORS: Record<WindowsCursorShape, CursorDefinition> = {
  arrow: {
    svg: '/cursors/windows/arrow.svg',
    hotspotX: 0.288,
    hotspotY: 0.189,
  },
  iBeam: {
    svg: '/cursors/windows/ibeam.svg',
    hotspotX: 0.490,
    hotspotY: 0.471,
  },
  wait: {
    svg: '/cursors/windows/wait.svg',
    hotspotX: 0.5,
    hotspotY: 0.52,
  },
  cross: {
    svg: '/cursors/windows/cross.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  upArrow: {
    svg: '/cursors/windows/uparrow.svg',
    hotspotX: 0.5,
    hotspotY: 0.05,
  },
  sizeNWSE: {
    svg: '/cursors/windows/idcsizenwse.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  sizeNESW: {
    svg: '/cursors/windows/size-nesw.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  sizeWE: {
    svg: '/cursors/windows/idcsizewe.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  sizeNS: {
    svg: '/cursors/windows/size-ns.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  sizeAll: {
    svg: '/cursors/windows/sizeall.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  no: {
    svg: '/cursors/windows/no.svg',
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  hand: {
    svg: '/cursors/windows/hand.svg',
    hotspotX: 0.441,
    hotspotY: 0.143,
  },
  appStarting: {
    svg: '/cursors/windows/appstarting.svg',
    hotspotX: 0.055,
    hotspotY: 0.368,
  },
  help: {
    svg: '/cursors/windows/idchelp.svg',
    hotspotX: 0.056,
    hotspotY: 0.127,
  },
  pin: {
    svg: '/cursors/windows/idcpin.svg',
    hotspotX: 0.245,
    hotspotY: 0.05,
  },
  person: {
    svg: '/cursors/windows/idcperson.svg',
    hotspotX: 0.235,
    hotspotY: 0.05,
  },
  pen: {
    svg: '/cursors/windows/pen.svg',
    hotspotX: 0.055,
    hotspotY: 0.945,
  },
  // Scroll cursors - no SVGs yet, use sizeAll as visual fallback
  // These will typically use bitmap capture which is more accurate
  scrollNS: {
    svg: '/cursors/windows/size-ns.svg', // Fallback to vertical resize
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  scrollWE: {
    svg: '/cursors/windows/idcsizewe.svg', // Fallback to horizontal resize
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  scrollNSEW: {
    svg: '/cursors/windows/sizeall.svg', // Fallback to 4-way
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  scrollN: {
    svg: '/cursors/windows/uparrow.svg', // Fallback to up arrow
    hotspotX: 0.5,
    hotspotY: 0.05,
  },
  scrollS: {
    svg: '/cursors/windows/uparrow.svg', // Fallback (rotated in CSS if needed)
    hotspotX: 0.5,
    hotspotY: 0.95,
  },
  scrollW: {
    svg: '/cursors/windows/idcsizewe.svg', // Fallback
    hotspotX: 0.05,
    hotspotY: 0.5,
  },
  scrollE: {
    svg: '/cursors/windows/idcsizewe.svg', // Fallback
    hotspotX: 0.95,
    hotspotY: 0.5,
  },
  scrollNW: {
    svg: '/cursors/windows/idcsizenwse.svg', // Fallback to diagonal
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  scrollNE: {
    svg: '/cursors/windows/size-nesw.svg', // Fallback to diagonal
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  scrollSW: {
    svg: '/cursors/windows/size-nesw.svg', // Fallback to diagonal
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  scrollSE: {
    svg: '/cursors/windows/idcsizenwse.svg', // Fallback to diagonal
    hotspotX: 0.5,
    hotspotY: 0.5,
  },
  arrowCD: {
    svg: '/cursors/windows/arrow.svg', // Fallback to standard arrow
    hotspotX: 0.288,
    hotspotY: 0.189,
  },
};

/**
 * Default cursor to use as fallback when no cursor data available.
 */
export const DEFAULT_CURSOR: CursorDefinition = WINDOWS_CURSORS.arrow;

/**
 * Get cursor definition by shape, with fallback to arrow.
 */
export function getCursorDefinition(shape: WindowsCursorShape): CursorDefinition {
  return WINDOWS_CURSORS[shape] ?? DEFAULT_CURSOR;
}
