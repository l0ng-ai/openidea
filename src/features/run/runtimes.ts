/**
 * Runtime lookup for run-context producers: `sdk_locate_tools` (project-local
 * `node_modules/.bin`, then the search path, with versions), cached for a
 * minute per directory. Without that command (an older backend) Node.js and
 * Rust come from SDK discovery and everything else resolves at launch.
 */
import { withRunTarget } from "@/platform/runTargetSelection";
import { call, commands, isTauri } from "@/platform/ipc";
import { isWindows } from "./jvmTypes";
import type { LocatedTool, ToolEnv } from "./producers";

const TTL = 60_000;

interface Entry {
  at: number;
  tool: LocatedTool | null | undefined;
}

const cache = new Map<string, Entry>();
let compileDir: string | null = null;
let locateUnavailable = false;

export function clearRuntimeCache() {
  cache.clear();
  locateUnavailable = false;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

async function viaSdkDetect(names: string[]): Promise<Map<string, LocatedTool | null | undefined>> {
  const out = new Map<string, LocatedTool | null | undefined>();
  for (const n of names) out.set(n, undefined);
  if (names.includes("node")) {
    const nodes = await call(commands.sdkDetect("node")).catch(() => []);
    const node = nodes.find((s) => s.source === "path") ?? nodes[0];
    out.set("node", node ? { path: node.path, version: node.version } : null);
  }
  if (names.includes("rustc")) {
    const rust = (await call(commands.sdkDetect("rust")).catch(() => []))[0];
    if (rust) out.set("rustc", { path: `${rust.path.replace(/\/+$/, "")}/rustc`, version: rust.version });
  }
  return out;
}

/** Looks up `names` near `file` (cached). */
export async function locateTools(
  names: string[],
  file: string | null,
): Promise<Map<string, LocatedTool | null | undefined>> {
  const near = file ? dirOf(file) : "";
  const now = Date.now();
  const out = new Map<string, LocatedTool | null | undefined>();
  const todo: string[] = [];
  for (const n of names) {
    const hit = cache.get(`${near}|${n}`);
    if (hit && now - hit.at < TTL) out.set(n, hit.tool);
    else todo.push(n);
  }
  if (!todo.length || !isTauri()) return out;
  let found: Map<string, LocatedTool | null | undefined>;
  if (!locateUnavailable) {
    try {
      const res = await call(commands.sdkLocateTools(todo, near || null));
      compileDir = res.compileDir;
      found = new Map(res.tools.map((t) => [t.name, t.path ? { path: t.path, version: t.version } : null]));
    } catch {
      // The backend predates `sdk_locate_tools` (needs a restart).
      locateUnavailable = true;
      found = await viaSdkDetect(todo);
    }
  } else {
    found = await viaSdkDetect(todo);
  }
  for (const n of todo) {
    const tool = found.get(n);
    out.set(n, tool);
    cache.set(`${near}|${n}`, { at: now, tool });
  }
  return out;
}

async function projectPython(file: string | null): Promise<string | null> {
  try {
    return await call(commands.sdkPythonEffective(file ? dirOf(file) : null));
  } catch {
    return null;
  }
}

async function projectPhp(): Promise<string | null> {
  try {
    return await call(commands.sdkPhpEffective());
  } catch {
    return null;
  }
}

export async function rootMarkers(root: string | null, file: string | null): Promise<{ deno: boolean; bun: boolean }> {
  if (!root) return { deno: false, bun: false };
  let dir = file && file.startsWith(root + "/") ? dirOf(file) : root;
  while (dir === root || dir.startsWith(root + "/")) {
    try {
      const entries = await call(commands.fsReadDir(dir));
      const names = new Set(entries.map((e) => e.name));
      const deno = names.has("deno.json") || names.has("deno.jsonc");
      const bun = names.has("bun.lockb") || names.has("bun.lock");
      if (deno || bun || names.has("package.json")) return { deno, bun };
    } catch {
      /* Unreadable ancestors contribute no runtime markers. */
    }
    if (dir === root) break;
    dir = dirOf(dir);
  }
  return { deno: false, bun: false };
}

/** The tool environment for running `file` with any of `names`. */
export async function toolEnv(
  names: string[],
  file: string | null,
  root: string | null,
  python: boolean,
  php = false,
): Promise<ToolEnv> {
  const targetFor = (command: string) =>
    withRunTarget({ command, kind: command } as import("@/bindings").RunConfig).target;
  const targetTools = new Set(
    names.filter(
      (n) =>
        ["php", "node", "npm", "npx", "pnpm", "yarn", "bun", "tsx", "ts-node"].includes(n) &&
        targetFor(n === "tsx" || n === "ts-node" ? "node" : n),
    ),
  );
  const phpTarget = php && targetFor("php");
  const [tools, py, phpInterpreter, markers] = await Promise.all([
    locateTools(
      names.filter((n) => !targetTools.has(n)),
      file,
    ),
    python ? projectPython(file) : Promise.resolve(null),
    phpTarget ? Promise.resolve("php") : php ? projectPhp() : Promise.resolve(null),
    names.includes("deno") || names.includes("bun")
      ? rootMarkers(root, file)
      : Promise.resolve({ deno: false, bun: false }),
  ]);
  return {
    tool: (n) => tools.get(n),
    compileDir: compileDir ?? "/tmp/openidea-run",
    windows: isWindows(),
    python: py,
    php: phpInterpreter,
    ...markers,
  };
}
