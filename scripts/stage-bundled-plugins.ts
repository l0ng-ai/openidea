/**
 * Copies the plugins listed in plugins/bundled.json from plugins/official/ to
 * src-tauri/bundled-plugins/<id>/, which tauri.conf.json bundles as the app's
 * `<resources>/plugins/`. Runs before `tauri build` (beforeBuildCommand); files
 * that didn't change are left alone, so Cargo doesn't rebuild for nothing.
 *
 * Components are checked in; web pages (`web = "…"`) are not: build those with
 * plugins/build.sh first. A listed plugin that is missing or unbuilt fails the build.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const official = join(root, "plugins", "official");
const target = join(root, "src-tauri", "bundled-plugins");
/** Build inputs and output that aren't part of a package. */
const SKIPPED = new Set(["target", "node_modules", "web-src"]);

const { plugins: ids } = JSON.parse(readFileSync(join(root, "plugins", "bundled.json"), "utf8")) as {
  plugins: string[];
};

const field = (manifest: string, key: string) =>
  [...manifest.matchAll(new RegExp(`^${key} *= *"([^"]+)"`, "gm"))].map((m) => m[1]!);

/** plugin id → its folder under plugins/official. */
const folders = new Map<string, string>();
for (const name of readdirSync(official)) {
  const file = join(official, name, "plugin.toml");
  if (existsSync(file)) folders.set(field(readFileSync(file, "utf8"), "id")[0] ?? "", join(official, name));
}

function sameFile(a: string, b: string): boolean {
  return existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

/** Makes `to` a copy of `from` (minus build inputs), writing only what changed. */
function sync(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  const wanted = new Set<string>();
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    wanted.add(entry.name);
    const [src, dst] = [join(from, entry.name), join(to, entry.name)];
    if (entry.isDirectory()) sync(src, dst);
    else if (!sameFile(src, dst)) copyFileSync(src, dst);
  }
  for (const name of readdirSync(to)) if (!wanted.has(name)) rmSync(join(to, name), { recursive: true });
}

const problems: string[] = [];
mkdirSync(target, { recursive: true });
for (const id of ids) {
  const dir = folders.get(id);
  if (!dir) {
    problems.push(`${id}: no plugin with this id in plugins/official`);
    continue;
  }
  const manifest = readFileSync(join(dir, "plugin.toml"), "utf8");
  const missing = [...field(manifest, "wasm"), ...field(manifest, "web")].filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    problems.push(`${id}: ${missing.join(", ")} missing; run plugins/build.sh ${relative(join(root, "plugins"), dir)}`);
    continue;
  }
  sync(dir, join(target, id));
  console.log(`bundled plugin ${id} <- ${relative(root, dir)}`);
}
for (const name of readdirSync(target)) if (!ids.includes(name)) rmSync(join(target, name), { recursive: true });

if (problems.length > 0) {
  for (const p of problems) console.error(`stage-bundled-plugins: ${p}`);
  process.exit(1);
}
