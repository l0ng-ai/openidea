/**
 * npm 工具窗口的独立数据源：直接扫描项目根与 workspace 成员的
 * `package.json`，与运行配置检测相互独立（IDEA 的 Maven 面板同理）——
 * 窗口只看磁盘上有没有 package.json，不受 run configs 检测结果影响。
 * 运行时仍复用 `scriptMenuItems`：有匹配配置就复用，没有则建临时配置。
 */
import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { objectEntries, scriptMenuItems, type ScriptEntry } from "./npmGutter";

/** 树节点：包（package.json 所在目录）或其下的一条脚本。 */
export type NpmNode = { kind: "package"; key: string; label: string; scripts: NpmScript[] } | NpmScript;

export interface NpmScript {
  kind: "script";
  key: string;
  /** 相对项目根的目录（"" 为根包）。 */
  dir: string;
  /** package.json 的绝对路径。 */
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

/**
 * 根包 `workspaces` 字段展开出的成员目录（相对根）。只支持单层 `*`
 * 通配（`packages/*`）；具体路径原样返回，`node_modules` 一律排除。
 */
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

/** 重新扫描 package.json：根包 + workspace 成员 + 后端检测的项目根（ruoyi-ui 这类前端子目录），构造包 → 脚本树。 */
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
  // 检测到的项目根（前端在子目录的项目：package.json 不在仓库根）。node 模块目录本身
  // 不在根列表里，只在 detectedFrom（"<dir>/package.json"）出现，从那里收模块目录。
  // 后端给的是相对项目根的路径（attach 项目的才是绝对路径）；跳过根外的与 Excluded 的。
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

/** 双击 / 菜单运行一条脚本：读盘上的 package.json，走 scriptMenuItems 的完整链路。 */
export async function runScriptNode(node: NpmScript, debug: boolean): Promise<void> {
  const content = await call(commands.fsReadText(node.path)).catch(() => "");
  const entry: ScriptEntry = { name: node.name, line: 0 };
  const items = await scriptMenuItems(entry, node.path, content ?? "");
  const item = items[debug ? 1 : 0];
  if (item && "run" in item) item.run?.();
}

/** 挂进 run feature 的激活链：项目切换、检测根刷新与 package.json 磁盘变化时重扫。 */
export function startNpmScriptsWatch(): () => void {
  const disposers = [
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void loadNpmScripts();
    }),
    useProjectRoots.subscribe((s, prev) => {
      if (s.detected !== prev.detected || s.root !== prev.root) void loadNpmScripts();
    }),
    onIdeEvent("fsChanged", (e) => {
      const changed = [...e.created, ...e.modified, ...e.removed];
      if (changed.some((p) => /(^|\/)package\.json$/.test(p))) void loadNpmScripts();
    }),
  ];
  void loadNpmScripts();
  return () => disposers.forEach((d) => d());
}
