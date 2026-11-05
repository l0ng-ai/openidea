/**
 * Runtime lookup for run-context producers: `sdk_locate_tools` (project-local
 * `node_modules/.bin`, then the search path, with versions), cached for a
 * minute per directory. Without that command (an older backend) Node.js and
 * Rust come from SDK discovery and everything else resolves at launch.
 */
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

async function projectPython(): Promise<string | null> {
  try {
    return await call(commands.sdkPythonEffective());
  } catch {
    return null;
  }
}

async function rootMarkers(root: string | null): Promise<{ deno: boolean; bun: boolean }> {
  if (!root) return { deno: false, bun: false };
  try {
    const entries = await call(commands.fsReadDir(root));
    const names = new Set(entries.map((e) => e.name));
    return {
      deno: names.has("deno.json") || names.has("deno.jsonc"),
      bun: names.has("bun.lockb") || names.has("bun.lock"),
    };
  } catch {
    return { deno: false, bun: false };
  }
}

/** The tool environment for running `file` with any of `names`. */
export async function toolEnv(
  names: string[],
  file: string | null,
  root: string | null,
  python: boolean,
): Promise<ToolEnv> {
  const [tools, py, markers] = await Promise.all([
    locateTools(names, file),
    python ? projectPython() : Promise.resolve(null),
    names.includes("deno") || names.includes("bun") ? rootMarkers(root) : Promise.resolve({ deno: false, bun: false }),
  ]);
  return {
    tool: (n) => tools.get(n),
    compileDir: compileDir ?? "/tmp/openidea-run",
    windows: isWindows(),
    python: py,
    ...markers,
  };
}
