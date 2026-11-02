/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);

const FONT_MIME_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export function resolveExcalidrawFontsDir(): string {
  const entry = require.resolve("@excalidraw/excalidraw");
  return path.resolve(path.dirname(entry), "fonts");
}

function excalidrawFontsPlugin(): Plugin {
  const fontsDir = resolveExcalidrawFontsDir();
  let resolvedOutDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");

  return {
    name: "openidea:excalidraw-fonts",
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/fonts", (req, res, next) => {
        if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        const cleanUrl = decodeURIComponent(req.url.split("?")[0] ?? "").replace(/^\/+/, "");
        if (!cleanUrl) {
          next();
          return;
        }
        const filePath = path.resolve(fontsDir, cleanUrl);
        if (!filePath.startsWith(`${fontsDir}${path.sep}`) || !existsSync(filePath)) {
          next();
          return;
        }
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) {
            next();
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.statusCode = 200;
          res.setHeader("Content-Type", FONT_MIME_TYPES[ext] ?? "application/octet-stream");
          res.setHeader("Content-Length", String(stat.size));
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.setHeader("Access-Control-Allow-Origin", "*");
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(filePath).pipe(res);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      if (!existsSync(fontsDir) || !existsSync(resolvedOutDir)) {
        return;
      }
      cpSync(fontsDir, path.resolve(resolvedOutDir, "fonts"), { recursive: true });
    },
  };
}

export default defineConfig(() => ({
  plugins: [react(), excalidrawFontsPlugin()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // `invoke` with remote-development routing (src/platform/tauriCore.ts).
      {
        find: /^@tauri-apps\/api\/core$/,
        replacement: fileURLToPath(new URL("./src/platform/tauriCore.ts", import.meta.url)),
      },
    ],
  },
  // Tauri: keep Rust errors visible, fixed port, don't watch the backend.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    target: "safari16",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "perf/**/*.test.ts", "scripts/**/*.test.ts"],
    server: {
      deps: {
        inline: [/excalidraw/, /open-color/],
      },
    },
  },
}));
