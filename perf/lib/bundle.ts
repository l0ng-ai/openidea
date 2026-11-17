/** The workbench's `--mode perf` production bundle: building it and serving it to Chromium. */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";

export function buildBundle(root: string, outDir: string, flags: string[] = []) {
  console.log("Building the workbench (vite build --mode perf)…");
  const r = spawnSync(
    "pnpm",
    ["exec", "vite", "build", "--mode", "perf", ...flags, "--outDir", outDir, "--emptyOutDir"],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
      shell: process.platform === "win32",
    },
  );
  if (r.status !== 0) throw new Error("vite build failed");
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Serves `dir` on a free local port (unknown paths: `index.html`). */
export function serveBundle(dir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = join(dir, path);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    }),
  );
}
