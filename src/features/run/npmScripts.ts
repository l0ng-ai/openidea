/**
 * The npm tool window's data: the project's `package.json` files (root, workspace members and
 * detected module roots) read from disk, independent of run configuration detection. Running a
 * script goes through `scriptMenuItems`, which reuses a matching configuration or makes a temporary one.
 */
import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { lazyComponent } from "@/ui";
import { registerToolWindow } from "@/workbench/contributions";
import { objectEntries, scriptMenuItems, type ScriptEntry } from "./npmGutter";

/** A package (the directory of a `package.json`) or one of its scripts. */
export type NpmNode = { kind: "package"; key: string; label: string; scripts: NpmScript[] } | NpmScript;

export interface NpmScript {
  kind: "script";
  key: string;
  /** Directory relative to the project root ("" for the root package). */
  dir: string;
  /** Absolute path of the `package.json`. */
  path: string;
  name: string;
}

interface NpmScriptsState {
  loaded: boolean;
  packages: NpmNode[];
}

export const useNpmScripts = create<NpmScriptsState>(() => ({ loaded: false, packages: [] }));

const safeJson = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Member directories (relative to the root) of the root package's `workspaces`: plain paths and one `*` level. */
async function workspaceDirs(pkg: Record<string, unknown>, root: string): Promise<string[]> {
  const ws = pkg.workspaces;
  const list = Array.isArray(ws)
    ? (ws as unknown[])
    : Array.isArray((ws as { packages?: unknown[] })?.packages)
      ? (ws as { packages: unknown[] }).packages
      : [];
  const out: string[] = [];
  for (const pattern of list) {
    if (typeof pattern !== "string" || !pattern || pattern.includes("..")) continue;
    const star = pattern.indexOf("*");
    if (star < 0) {
      out.push(pattern.replace(/\/+$/, ""));
      continue;
    }
    const parent = pattern.slice(0, star).replace(/\/+$/, "");
    const suffix = pattern.slice(star + 1);
    const entries = await call(commands.fsReadDir(parent ? `${root}/${parent}` : root)).catch(() => []);
    for (const e of entries) {
      const isDir = e.kind === "dir" || e.targetKind === "dir";
      if (!isDir || e.ignored || e.excluded || e.name === "node_modules") continue;
      if (suffix && !e.name.endsWith(suffix)) continue;
      out.push(parent ? `${parent}/${e.name}` : e.name);
    }
  }
  return out;
}

let loadGen = 0;

/** Rescans the packages and their scripts. */
export async function loadNpmScripts(): Promise<void> {
  const root = useProject.getState().project?.root ?? null;
  const gen = ++loadGen;
  if (!root || !isTauri()) {
    useNpmScripts.setState({ loaded: true, packages: [] });
    return;
  }
  const rootName = useProject.getState().project?.name ?? root;
  const dirs = new Set([""]);
  const rootText = await call(commands.fsReadText(`${root}/package.json`)).catch(() => null);
  const rootPkg = rootText !== null ? safeJson(rootText) : null;
  if (rootPkg) for (const dir of await workspaceDirs(rootPkg, root)) dirs.add(dir);
  // Detected roots cover a front end in a subdirectory. A node module's own directory only shows
  // up in `detectedFrom` ("<dir>/package.json"). Roots outside the project (absolute) are skipped.
  for (const r of useProjectRoots.getState().detected) {
    const abs = r.path.startsWith(`${root}/`) ? r.path.slice(root.length + 1) : r.path;
    const rel = /^[A-Za-z]:[\\/]|^\//.test(abs) ? null : abs;
    if (rel === null) continue;
    if (r.kind !== "excluded" && rel) dirs.add(rel);
    if (r.detectedFrom) {
      const moduleDir = r.detectedFrom.replace(/\/[^/]+$/, "");
      if (moduleDir && !/^[A-Za-z]:[\\/]|^\//.test(moduleDir)) dirs.add(moduleDir);
    }
  }
  // Any other package.json the index knows, outside node_modules.
  const indexed = await call(commands.findFilesNamed("package.json")).catch(() => []);
  for (const file of indexed.slice(0, 500)) {
    const path = String(file).replace(/\\/g, "/");
    if (!path.startsWith(`${root}/`) || path.includes("/node_modules/")) continue;
    dirs.add(path.slice(root.length + 1).replace(/\/?package\.json$/, ""));
  }
  const packages: NpmNode[] = [];
  await Promise.all(
    [...dirs].map(async (dir) => {
      const path = dir ? `${root}/${dir}/package.json` : `${root}/package.json`;
      const text = await call(commands.fsReadText(path)).catch(() => null);
      if (text === null) return;
      const scripts: NpmScript[] = objectEntries(text, "scripts").map((e: ScriptEntry) => ({
        kind: "script" as const,
        key: `npm:${dir ? `${dir}:` : ""}${e.name}`,
        dir,
        path,
        name: e.name,
      }));
      if (scripts.length === 0) return;
      scripts.sort((a, b) => a.name.localeCompare(b.name));
      packages.push({ kind: "package", key: `pkg:${dir}`, label: dir === "" ? rootName : dir, scripts });
    }),
  );
  if (gen !== loadGen) return;
  packages.sort((a, b) =>
    a.kind === "package" && b.kind === "package"
      ? a.label === rootName
        ? -1
        : b.label === rootName
          ? 1
          : a.label.localeCompare(b.label)
      : 0,
  );
  useNpmScripts.setState({ loaded: true, packages });
}

/** Runs or debugs a script the way its gutter icon does. */
export async function runScriptNode(node: NpmScript, debug: boolean): Promise<void> {
  const content = await call(commands.fsReadText(node.path)).catch(() => "");
  const entry: ScriptEntry = { name: node.name, line: 0 };
  const items = await scriptMenuItems(entry, node.path, content ?? "");
  const item = items[debug ? 1 : 0];
  if (item && "run" in item) item.run?.();
}

/** Keeps the scripts current and shows the npm tool window while the project has any. */
export function startNpmScriptsWatch(): () => void {
  let unregister: (() => void) | null = null;
  let indexing = true;
  const syncToolWindow = (has: boolean) => {
    if (has && !unregister)
      unregister = registerToolWindow({
        id: "npm-scripts",
        title: "npm",
        icon: "file-npm",
        anchor: "right",
        order: 13,
        component: lazyComponent(() => import("./NpmScriptsView").then((m) => m.NpmScriptsView)),
      });
    else if (!has && unregister) {
      unregister();
      unregister = null;
    }
  };
  const disposers = [
    useNpmScripts.subscribe((s) => syncToolWindow(s.packages.length > 0)),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void loadNpmScripts();
    }),
    useProjectRoots.subscribe((s, prev) => {
      if (s.detected !== prev.detected || s.root !== prev.root) void loadNpmScripts();
    }),
    onIdeEvent("indexState", (e) => {
      if (indexing && !e.indexing) void loadNpmScripts();
      indexing = e.indexing;
    }),
    onIdeEvent("fsChanged", (e) => {
      const changed = [...e.created, ...e.modified, ...e.removed];
      if (changed.some((p) => /(^|\/)package\.json$/.test(p) && !p.includes("/node_modules/"))) void loadNpmScripts();
    }),
  ];
  void loadNpmScripts();
  return () => {
    disposers.forEach((d) => d());
    syncToolWindow(false);
  };
}
