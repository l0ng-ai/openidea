/**
 * Builds the page into ../web (not checked in: plugins/build.sh builds it).
 * Relative URLs throughout: the IDE serves the page from
 * the plugin package under its own URL scheme. Excalidraw's fonts are copied
 * next to it; the page points Excalidraw at them (src/assets.ts).
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const outDir = path.resolve(import.meta.dirname, "../web");

function excalidrawFonts(): Plugin {
  return {
    name: "openidea:excalidraw-fonts",
    apply: "build",
    closeBundle() {
      const fonts = path.resolve(path.dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
      if (!existsSync(fonts)) throw new Error(`no Excalidraw fonts at ${fonts}`);
      rmSync(path.join(outDir, "fonts"), { recursive: true, force: true });
      cpSync(fonts, path.join(outDir, "fonts"), { recursive: true });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), excalidrawFonts()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  test: {
    // Excalidraw needs a DOM even for its data API; its packages ship JSON and CSS imports Node can't load.
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    server: { deps: { inline: [/@excalidraw/, /open-color/] } },
  },
});
