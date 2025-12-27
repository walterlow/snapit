export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface CaptureSource {
  monitor?: number;
  window_id?: number;
  window_title?: string;
  region?: Region;
}

// Base annotation interface for generic shapes
export interface ShapeAnnotation {
  id: string;
  type: string;
  [key: string]: unknown;
}

// Special annotation for crop bounds (stored to persist crop state)
export interface CropBoundsAnnotation {
  id: '__crop_bounds__';
  type: '__crop_bounds__';
  width: number;
  height: number;
  imageOffsetX: number;
  imageOffsetY: number;
}

// Special annotation for compositor settings (stored to persist background effects)
export interface CompositorSettingsAnnotation {
  id: '__compositor_settings__';
  type: '__compositor_settings__';
  enabled: boolean;
  backgroundType: BackgroundType;
  backgroundColor: string;
  gradientAngle: number;
  gradientStops: GradientStop[];
  backgroundImage: string | null;
  padding: number;
  borderRadius: number;
  shadowEnabled: boolean;
  shadowIntensity: number;
  aspectRatio: CompositorSettings['aspectRatio'];
}

// Union type for all annotation types
export type Annotation = ShapeAnnotation | CropBoundsAnnotation | CompositorSettingsAnnotation;

// Type guards for annotation types
export function isCropBoundsAnnotation(ann: Annotation): ann is CropBoundsAnnotation {
  return ann.type === '__crop_bounds__';
}

export function isCompositorSettingsAnnotation(ann: Annotation): ann is CompositorSettingsAnnotation {
  return ann.type === '__compositor_settings__';
}

export interface CaptureProject {
  id: string;
  created_at: string;
  updated_at: string;
  capture_type: 'region' | 'fullscreen' | 'window';
  source: CaptureSource;
  original_image: string;
  dimensions: Dimensions;
  annotations: Annotation[];
  tags: string[];
  favorite: boolean;
}

export interface CaptureListItem {
  id: string;
  created_at: string;
  updated_at: string;
  capture_type: string;
  dimensions: Dimensions;
  thumbnail_path: string;
  image_path: string;
  has_annotations: boolean;
  tags: string[];
  favorite: boolean;
  /** True if the original image file is missing from disk */
  is_missing: boolean;
}

export interface CaptureResult {
  image_data: string;
  width: number;
  height: number;
}

// Fast capture result - returns file path instead of base64 data
export interface FastCaptureResult {
  file_path: string;
  width: number;
  height: number;
  has_transparency: boolean;
}

// Screen region selection using absolute screen coordinates (multi-monitor support)
export interface ScreenRegionSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
  scale_factor: number;
}

export interface StorageStats {
  total_size_bytes: number;
  total_size_mb: number;
  capture_count: number;
  storage_path: string;
}

export type Tool = 'select' | 'arrow' | 'rect' | 'circle' | 'text' | 'blur' | 'highlight' | 'steps' | 'crop' | 'pen' | 'background';

export interface CanvasShape {
  id: string;
  type: string;
  x?: number;
  y?: number;
  points?: number[];
  width?: number;
  height?: number;
  radius?: number; // Legacy - use radiusX/radiusY for ellipses
  radiusX?: number; // Ellipse horizontal radius
  radiusY?: number; // Ellipse vertical radius
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string; // 'normal' | 'bold' | 'italic' | 'bold italic'
  textDecoration?: string; // '' | 'underline' | 'line-through'
  align?: string; // 'left' | 'center' | 'right'
  verticalAlign?: string; // 'top' | 'middle' | 'bottom'
  wrap?: string; // 'word' | 'char' | 'none'
  lineHeight?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  number?: number;
  pixelSize?: number;
  blurType?: BlurType;
  blurAmount?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

export interface SaveCaptureRequest {
  image_data: string;
  capture_type: string;
  source: CaptureSource;
}

export interface SaveCaptureResponse {
  id: string;
  project: CaptureProject;
  thumbnail_path: string;
  image_path: string;
}

// Compositor types for background effects
export type BackgroundType = 'solid' | 'gradient' | 'image';

export interface GradientStop {
  color: string;
  position: number; // 0-100
}

export interface CompositorSettings {
  enabled: boolean;
  backgroundType: BackgroundType;
  backgroundColor: string;
  gradientAngle: number; // degrees
  gradientStops: GradientStop[];
  backgroundImage: string | null; // base64 or URL
  padding: number; // pixels (direct, no conversion)
  borderRadius: number; // pixels
  shadowEnabled: boolean;
  shadowIntensity: number; // 0-1
  aspectRatio: 'auto' | '16:9' | '4:3' | '1:1' | 'twitter' | 'instagram';
}

export const DEFAULT_COMPOSITOR_SETTINGS: CompositorSettings = {
  enabled: false,
  backgroundType: 'gradient',
  backgroundColor: '#6366f1',
  gradientAngle: 135,
  gradientStops: [
    { color: '#667eea', position: 0 },
    { color: '#764ba2', position: 100 },
  ],
  backgroundImage: null,
  padding: 64,
  borderRadius: 12,
  shadowEnabled: true,
  shadowIntensity: 0.5,
  aspectRatio: 'auto',
};

export const GRADIENT_PRESETS = [
  { name: 'Purple Dream', stops: [{ color: '#667eea', position: 0 }, { color: '#764ba2', position: 100 }] },
  { name: 'Ocean Blue', stops: [{ color: '#2193b0', position: 0 }, { color: '#6dd5ed', position: 100 }] },
  { name: 'Sunset', stops: [{ color: '#f12711', position: 0 }, { color: '#f5af19', position: 100 }] },
  { name: 'Forest', stops: [{ color: '#134e5e', position: 0 }, { color: '#71b280', position: 100 }] },
  { name: 'Midnight', stops: [{ color: '#232526', position: 0 }, { color: '#414345', position: 100 }] },
  { name: 'Cotton Candy', stops: [{ color: '#ff9a9e', position: 0 }, { color: '#fecfef', position: 100 }] },
  { name: 'Northern Lights', stops: [{ color: '#43cea2', position: 0 }, { color: '#185a9d', position: 100 }] },
  { name: 'Flamingo', stops: [{ color: '#f953c6', position: 0 }, { color: '#b91d73', position: 100 }] },
];

// Default wallpapers from public/wallpapers
// Full resolution images for actual background use
export const DEFAULT_WALLPAPERS = [
  '/wallpapers/wallpaper1.jpg',
  '/wallpapers/wallpaper2.jpg',
  '/wallpapers/wallpaper3.jpg',
  '/wallpapers/wallpaper4.jpg',
  '/wallpapers/wallpaper5.jpg',
  '/wallpapers/wallpaper6.jpg',
  '/wallpapers/wallpaper7.jpg',
  '/wallpapers/wallpaper8.jpg',
  '/wallpapers/wallpaper9.jpg',
  '/wallpapers/wallpaper10.jpg',
  '/wallpapers/wallpaper11.jpg',
  '/wallpapers/wallpaper12.jpg',
  '/wallpapers/wallpaper13.jpg',
  '/wallpapers/wallpaper14.jpg',
  '/wallpapers/wallpaper15.jpg',
  '/wallpapers/wallpaper16.jpg',
  '/wallpapers/wallpaper17.jpg',
  '/wallpapers/wallpaper18.jpg',
];

// Thumbnails for fast gallery loading (200px wide, ~5KB each vs ~1MB originals)
export const WALLPAPER_THUMBNAILS = [
  '/wallpapers/thumbs/wallpaper1.jpg',
  '/wallpapers/thumbs/wallpaper2.jpg',
  '/wallpapers/thumbs/wallpaper3.jpg',
  '/wallpapers/thumbs/wallpaper4.jpg',
  '/wallpapers/thumbs/wallpaper5.jpg',
  '/wallpapers/thumbs/wallpaper6.jpg',
  '/wallpapers/thumbs/wallpaper7.jpg',
  '/wallpapers/thumbs/wallpaper8.jpg',
  '/wallpapers/thumbs/wallpaper9.jpg',
  '/wallpapers/thumbs/wallpaper10.jpg',
  '/wallpapers/thumbs/wallpaper11.jpg',
  '/wallpapers/thumbs/wallpaper12.jpg',
  '/wallpapers/thumbs/wallpaper13.jpg',
  '/wallpapers/thumbs/wallpaper14.jpg',
  '/wallpapers/thumbs/wallpaper15.jpg',
  '/wallpapers/thumbs/wallpaper16.jpg',
  '/wallpapers/thumbs/wallpaper17.jpg',
  '/wallpapers/thumbs/wallpaper18.jpg',
];

// Blur effect types
export type BlurType = 'pixelate' | 'gaussian';

// Default font families (fallback if system fonts not loaded)
export const DEFAULT_FONT_FAMILIES = [
  'Arial',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
] as const;

export type FontFamily = string;

// ============================================
// Settings Types
// ============================================

// Shortcut registration status
export type ShortcutStatus = 'registered' | 'conflict' | 'error' | 'pending';

// Individual shortcut configuration
export interface ShortcutConfig {
  id: string;
  name: string;
  description: string;
  defaultShortcut: string;
  currentShortcut: string;
  status: ShortcutStatus;
  useHook: boolean; // Whether to use low-level hook for override
}

// Image format options
export type ImageFormat = 'png' | 'jpg' | 'webp' | 'gif' | 'bmp';

// Theme options
export type Theme = 'light' | 'dark' | 'system';

// General application settings
export interface GeneralSettings {
  startWithWindows: boolean;
  minimizeToTray: boolean;
  showNotifications: boolean;
  defaultSaveDir: string | null;
  imageFormat: ImageFormat;
  jpgQuality: number; // 0-100
  allowOverride: boolean; // Allow SnapIt to override shortcuts registered by other apps
  theme: Theme; // App color theme
}

// Complete application settings
export interface AppSettings {
  shortcuts: Record<string, ShortcutConfig>;
  general: GeneralSettings;
}

// Default shortcut configurations
export const DEFAULT_SHORTCUTS: Record<string, ShortcutConfig> = {
  new_capture: {
    id: 'new_capture',
    name: 'New Capture',
    description: 'Capture a window or region of the screen',
    defaultShortcut: 'PrintScreen',
    currentShortcut: 'PrintScreen',
    status: 'pending',
    useHook: true,
  },
  fullscreen_capture: {
    id: 'fullscreen_capture',
    name: 'Fullscreen Capture',
    description: 'Capture the current monitor',
    defaultShortcut: 'Shift+PrintScreen',
    currentShortcut: 'Shift+PrintScreen',
    status: 'pending',
    useHook: true,
  },
  all_monitors_capture: {
    id: 'all_monitors_capture',
    name: 'All Monitors',
    description: 'Capture all monitors combined',
    defaultShortcut: 'Ctrl+PrintScreen',
    currentShortcut: 'Ctrl+PrintScreen',
    status: 'pending',
    useHook: true,
  },
};

// Default general settings
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  startWithWindows: false,
  minimizeToTray: true,
  showNotifications: true,
  defaultSaveDir: null,
  imageFormat: 'png',
  jpgQuality: 85,
  allowOverride: false,
  theme: 'system', // Follow OS preference by default
};

// Default complete settings
export const DEFAULT_SETTINGS: AppSettings = {
  shortcuts: DEFAULT_SHORTCUTS,
  general: DEFAULT_GENERAL_SETTINGS,
};

// ============================================
// Capture Type (used in RegionSelector)
// ============================================

/** Type of capture action to perform after region selection */
export type CaptureType = 'screenshot' | 'video' | 'gif';

// ============================================
// Video Recording Types (generated from Rust via ts-rs)
// ============================================

// Re-export generated types - single source of truth from Rust
export type {
  AudioSettings,
  RecordingFormat,
  RecordingMode,
  RecordingSettings,
  RecordingState,
  RecordingStatus,
  StartRecordingResult,
  StopRecordingResult,
  VideoFormat,
} from './generated';

// Import for use in default settings
import type { RecordingSettings } from './generated';

/** Default recording settings */
export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  format: 'mp4',
  mode: { type: 'monitor', monitorIndex: 0 },
  fps: 30,
  maxDurationSecs: null,
  includeCursor: true,
  audio: {
    captureSystemAudio: true,
    captureMicrophone: false,
  },
  quality: 80,
  gifQualityPreset: 'balanced',
  countdownSecs: 3,
};

// ============================================
// Shape Component Types
// ============================================

import type Konva from 'konva';

// Base props shared by all shape components
export interface BaseShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}
