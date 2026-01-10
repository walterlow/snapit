/**
 * Wallpaper configuration - matches Cap's built-in wallpapers
 */

// Wallpaper categories/themes
export const WALLPAPER_THEMES = {
  macOS: 'macOS',
  blue: 'Blue',
  purple: 'Purple',
  dark: 'Dark',
  orange: 'Orange',
} as const;

export type WallpaperTheme = keyof typeof WALLPAPER_THEMES;

// All wallpaper IDs organized by theme
// Format: "theme/filename" (without .jpg extension)
export const WALLPAPERS_BY_THEME: Record<WallpaperTheme, string[]> = {
  macOS: [
    'macOS/sequoia-dark',
    'macOS/sequoia-light',
    'macOS/sonoma-clouds',
    'macOS/sonoma-dark',
    'macOS/sonoma-evening',
    'macOS/sonoma-fromabove',
    'macOS/sonoma-horizon',
    'macOS/sonoma-light',
    'macOS/sonoma-river',
    'macOS/tahoe-dark',
    'macOS/tahoe-dawn-min',
    'macOS/tahoe-day-min',
    'macOS/tahoe-dusk-min',
    'macOS/tahoe-light',
    'macOS/tahoe-night-min',
    'macOS/ventura',
    'macOS/ventura-dark',
    'macOS/ventura-semi-dark',
  ],
  blue: [
    'blue/1',
    'blue/2',
    'blue/3',
    'blue/4',
    'blue/5',
    'blue/6',
  ],
  purple: [
    'purple/1',
    'purple/2',
    'purple/3',
    'purple/4',
    'purple/5',
    'purple/6',
  ],
  dark: [
    'dark/1',
    'dark/2',
    'dark/3',
    'dark/4',
    'dark/5',
    'dark/6',
  ],
  orange: [
    'orange/1',
    'orange/2',
    'orange/3',
    'orange/4',
    'orange/5',
    'orange/6',
    'orange/7',
    'orange/8',
    'orange/9',
  ],
};

// Flat list of all wallpaper IDs
export const ALL_WALLPAPER_IDS = Object.values(WALLPAPERS_BY_THEME).flat();

// Display name for wallpaper ID
export function getWallpaperDisplayName(wallpaperId: string): string {
  const parts = wallpaperId.split('/');
  const name = parts[parts.length - 1];
  // Convert kebab-case to title case
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Gradient presets for the gradient background tab
export const GRADIENT_PRESETS = [
  { name: 'Blue to Pink', start: '#4785ff', end: '#ff4766', angle: 135 },
  { name: 'Purple Dream', start: '#667eea', end: '#764ba2', angle: 135 },
  { name: 'Ocean Blue', start: '#2193b0', end: '#6dd5ed', angle: 135 },
  { name: 'Sunset', start: '#f12711', end: '#f5af19', angle: 135 },
  { name: 'Forest', start: '#134e5e', end: '#71b280', angle: 135 },
  { name: 'Midnight', start: '#232526', end: '#414345', angle: 135 },
  { name: 'Cotton Candy', start: '#ff9a9e', end: '#fecfef', angle: 135 },
  { name: 'Northern Lights', start: '#43cea2', end: '#185a9d', angle: 135 },
  { name: 'Flamingo', start: '#f953c6', end: '#b91d73', angle: 135 },
  { name: 'Peach', start: '#ffecd2', end: '#fcb69f', angle: 135 },
  { name: 'Deep Space', start: '#000000', end: '#434343', angle: 135 },
  { name: 'Aqua Marine', start: '#1a2980', end: '#26d0ce', angle: 135 },
];

// Solid color presets
export const COLOR_PRESETS = [
  '#ffffff', // White
  '#000000', // Black
  '#1a1a1a', // Near black
  '#f5f5f5', // Light gray
  '#3b82f6', // Blue
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#ef4444', // Red
  '#f97316', // Orange
  '#22c55e', // Green
  '#06b6d4', // Cyan
  '#eab308', // Yellow
];
