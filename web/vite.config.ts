import { defineConfig } from "vite";

// Relative base so the same build works locally and on GitHub Pages (/<repo>/).
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 1500 }, // MapLibre alone is ~800 kB
});
