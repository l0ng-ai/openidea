import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { normalizeBasePath } from "./src/lib/paths.mjs";

export default defineConfig(({ mode }) => ({
  base: normalizeBasePath(process.env.BASE_PATH),
  plugins: [
    stylex.vite({
      devMode: "css-only",
      dev: mode === "development",
      // Keep atomic styles above the reset layer regardless of dev stylesheet load order.
      useCSSLayers: false,
      runtimeInjection: false,
    }),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: false, failOnError: true },
    }),
    react(),
  ],
}));
