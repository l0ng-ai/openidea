import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const outDir = path.resolve(import.meta.dirname, "../web");

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048,
  },
});
