import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Renderer build for the Electron shell (electron/main.cjs). `base: "./"` makes
// the built assets resolve under file:// when Electron loads dist/index.html in
// production; the fixed dev port is what main.cjs points at in development.
export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // Electron ships a recent Chromium, so target modern Chrome.
    target: "chrome128",
    sourcemap: false,
  },
});
