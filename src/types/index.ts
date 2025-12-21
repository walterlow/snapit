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

export interface Annotation {
  id: string;
  type: string;
  [key: string]: unknown;
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
  has_annotations: boolean;
  tags: string[];
  favorite: boolean;
}

export interface CaptureResult {
  image_data: string;
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

export type Tool = 'select' | 'arrow' | 'rect' | 'circle' | 'text' | 'blur' | 'highlight' | 'steps' | 'crop' | 'pen';

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
  padding: number; // percentage 0-50
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
  padding: 10,
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
export type ImageFormat = 'png' | 'jpg' | 'webp';

// General application settings
export interface GeneralSettings {
  startWithWindows: boolean;
  minimizeToTray: boolean;
  showNotifications: boolean;
  defaultSaveDir: string | null;
  imageFormat: ImageFormat;
  jpgQuality: number; // 0-100
  allowOverride: boolean; // Allow SnapIt to override shortcuts registered by other apps
}

// Complete application settings
export interface AppSettings {
  shortcuts: Record<string, ShortcutConfig>;
  general: GeneralSettings;
}

// Default shortcut configurations
export const DEFAULT_SHORTCUTS: Record<string, ShortcutConfig> = {
  region_capture: {
    id: 'region_capture',
    name: 'Region Capture',
    description: 'Capture a selected area of the screen',
    defaultShortcut: 'Ctrl+Shift+S',
    currentShortcut: 'Ctrl+Shift+S',
    status: 'pending',
    useHook: false,
  },
  fullscreen_capture: {
    id: 'fullscreen_capture',
    name: 'Fullscreen Capture',
    description: 'Capture the entire screen',
    defaultShortcut: 'Ctrl+Shift+F',
    currentShortcut: 'Ctrl+Shift+F',
    status: 'pending',
    useHook: false,
  },
  window_capture: {
    id: 'window_capture',
    name: 'Window Capture',
    description: 'Capture a specific window',
    defaultShortcut: 'Ctrl+Shift+W',
    currentShortcut: 'Ctrl+Shift+W',
    status: 'pending',
    useHook: false,
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
};

// Default complete settings
export const DEFAULT_SETTINGS: AppSettings = {
  shortcuts: DEFAULT_SHORTCUTS,
  general: DEFAULT_GENERAL_SETTINGS,
};
