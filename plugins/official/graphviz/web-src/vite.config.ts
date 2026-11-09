/**
 * Builds the page into ../web (not checked in: plugins/build.sh builds it).
 * Relative URLs throughout: the IDE serves the page from the plugin package
 * under its own URL scheme.
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "../web"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
