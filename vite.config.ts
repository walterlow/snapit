import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, basename } from "path";
import { readdirSync } from "fs";

const host = process.env.TAURI_DEV_HOST;

// Auto-discover all HTML entry points
// - index.html stays at root (main library window)
// - All other windows are in windows/ folder
// This prevents issues where new HTML files work in dev but fail in release builds
function getHtmlEntryPoints() {
  const entries: Record<string, string> = {
    main: resolve(__dirname, "index.html"),
  };

  const windowsDir = resolve(__dirname, "windows");
  const windowFiles = readdirSync(windowsDir).filter((file) =>
    file.endsWith(".html")
  );

  for (const file of windowFiles) {
    const name = basename(file, ".html");
    entries[name] = resolve(windowsDir, file);
  }

  return entries;
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },

  // Ensure WASM files are served correctly
  assetsInclude: ["**/*.wasm"],

  optimizeDeps: {
    // Exclude WASM modules from dependency optimization
    exclude: ["text-renderer-wasm"],
  },

  // Multi-page build configuration - auto-discovers all HTML files in root
  build: {
    rollupOptions: {
      input: getHtmlEntryPoints(),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "0.0.0.0",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
