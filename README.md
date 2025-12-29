# SnapIt

A fast, native screen capture and annotation tool for Windows. Built with Tauri 2, React 19, and Rust.

## Features

### Screen Capture
- **Region capture** - Select any area of your screen
- **Fullscreen capture** - Capture the entire current monitor
- **All monitors** - Capture across multiple displays
- **Global hotkeys** - Capture from anywhere with customizable shortcuts

### Annotation Tools
- **Shapes** - Rectangle, ellipse, arrow, line
- **Text** - Add labels with customizable fonts and styles
- **Highlight** - Draw attention to important areas
- **Blur/Pixelate** - Hide sensitive information
- **Step numbers** - Create numbered instructions
- **Pen** - Freehand drawing
- **Crop** - Trim your captures

### Background Compositor
- Solid color backgrounds
- Gradient backgrounds with presets
- Custom wallpaper images
- Padding, border radius, and shadow effects
- Aspect ratio presets (16:9, 4:3, 1:1, Twitter, Instagram)

### Library
- Organize captures with tags and favorites
- Search and filter your capture history
- Thumbnail previews
- Quick access to recent captures

### Video Recording
- Screen recording with system audio
- Microphone input support
- GIF export
- Webcam overlay

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Run tests
npm run test:run

# Type check
npx tsc --noEmit
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build frontend |
| `npm run tauri dev` | Run app in development |
| `npm run tauri build` | Build production app |
| `npm run test` | Run tests in watch mode |
| `npm run test:run` | Run tests once |
| `npm run test:coverage` | Run tests with coverage |

### Project Structure

```
snapit/
├── src/                    # React frontend
│   ├── components/         # UI components
│   │   ├── Editor/         # Canvas annotation editor
│   │   ├── Library/        # Capture library view
│   │   ├── Settings/       # Settings modal
│   │   └── ui/             # Shared UI primitives (shadcn/ui)
│   ├── hooks/              # Custom React hooks
│   ├── stores/             # Zustand state management
│   ├── types/              # TypeScript types
│   └── views/              # Main view components
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands/       # Tauri command handlers
│   │   │   ├── capture/    # Screen capture
│   │   │   ├── storage/    # Project persistence
│   │   │   └── video_recording/  # Recording features
│   │   └── lib.rs          # Main entry point
│   └── tauri.conf.json     # Tauri configuration
└── public/                 # Static assets
```

### Type Generation

Rust types are automatically synced to TypeScript using [ts-rs](https://github.com/Aleph-Alpha/ts-rs):

```bash
# Generate TypeScript types from Rust
cargo test --lib
```

Generated types are placed in `src/types/generated/` and re-exported from `src/types/index.ts`.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Zustand
- **Canvas**: Konva / react-konva
- **UI Components**: shadcn/ui (Radix UI primitives)
- **Backend**: Tauri 2, Rust
- **Build**: Vite 7, Vitest

