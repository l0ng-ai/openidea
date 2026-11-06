import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeBasePath } from "../src/lib/paths.mjs";

export async function checkStatic(root, basePath = "/") {
  const base = normalizeBasePath(basePath);
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const visibleText = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.match(visibleText, /The IDE you know,\s*rebuilt in Rust\./, "Missing prerendered homepage");
  for (const text of [
    "Keep your way of working.",
    "Startup and memory.",
    "169 MB",
    "Warm caches",
    "IDEA analyses Python more deeply",
    "Try OpenIDEA.",
  ]) {
    assert.ok(visibleText.includes(text), `Missing prerendered homepage content: ${text}`);
  }

  const checked = new Set();
  async function checkAsset(reference, parent = new URL(base, "https://pages.test")) {
    if (/^(?:https?:|data:|mailto:|#|\/\/)/.test(reference)) return;
    const url = new URL(reference, parent);
    assert.ok(url.pathname.startsWith(base), `Asset escaped base path ${base}: ${reference}`);
    const relative = decodeURIComponent(url.pathname.slice(base.length));
    if (!relative || checked.has(relative)) return;
    checked.add(relative);
    const file = resolve(root, relative);
    assert.ok(file.startsWith(`${resolve(root)}/`), `Asset escaped output directory: ${reference}`);
    await access(file).catch(() => {
      throw new Error(`Missing asset: ${reference}`);
    });
    if ((await stat(file)).isDirectory()) {
      await access(resolve(file, "index.html")).catch(() => {
        throw new Error(`Missing prerendered index: ${reference}`);
      });
    }
    if (relative.endsWith(".css")) {
      const css = await readFile(file, "utf8");
      assert.ok(
        css.includes("cursor:zoom-in") || css.includes("cursor: zoom-in"),
        "Missing compiled StyleX component styles",
      );
      for (const match of css.matchAll(/url\(["']?([^\s)"']+)["']?\)/g)) await checkAsset(match[1], url);
    }
  }
  const pages = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".html"));
  for (const page of pages) {
    const pageHtml = await readFile(resolve(root, page), "utf8");
    const pageUrl = new URL(`${base}${page.replace(/index\.html$/, "")}`, "https://pages.test");
    for (const match of pageHtml.matchAll(/(?:src|href)="([^"]+)"/g)) await checkAsset(match[1], pageUrl);
  }
  assert.ok(checked.size > 0, "No local assets in prerendered homepage");
  return { assets: checked.size, basePath: base, pages: pages.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkStatic(resolve("dist/client"), process.env.BASE_PATH);
  for (const route of ["download", "download/macos", "download/windows", "download/linux"]) {
    const page = await readFile(resolve("dist/client", route, "index.html"), "utf8");
    assert.match(page, /<h1[^>]*>Download/, `Missing prerendered download page: ${route}`);
  }
  console.log(`Static website verified: ${result.pages} pages, ${result.assets} assets, base path ${result.basePath}`);
}
