import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

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

  // Multi-page build configuration
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "recording-border": resolve(__dirname, "recording-border.html"),
        "capture-toolbar": resolve(__dirname, "capture-toolbar.html"),
        countdown: resolve(__dirname, "countdown.html"),
        "webcam-preview": resolve(__dirname, "webcam-preview.html"),
        settings: resolve(__dirname, "settings.html"),
      },
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
