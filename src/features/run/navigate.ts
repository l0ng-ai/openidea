/** Opens file locations printed in run output (resolving relative and bare names). */
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { editorService, notifications } from "@/workbench/contributions";
import { streamSearch } from "@/features/search/common/textSearch";
import { joinPath, type FileTarget } from "./links";
import { findRubyTest } from "./rubyTests";
import { tx } from "@/platform/i18n";

async function exists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash) || "/";
  const name = path.slice(slash + 1);
  try {
    const entries = await call(commands.fsReadDir(dir));
    return entries.some((e) => e.name === name && e.kind !== "dir");
  } catch {
    return false;
  }
}

const packageOf = (className: string) =>
  className.includes(".") ? className.slice(0, className.lastIndexOf(".")) : "";

/** Whether a JVM source file declares `pkg` (Kotlin files needn't sit in their package's directory). */
async function declaresPackage(path: string, pkg: string): Promise<boolean> {
  try {
    const text = (await call(commands.fsReadText(path))).slice(0, 20_000);
    const declared = /^\s*package\s+([\w.`]+)/m.exec(text)?.[1]?.replace(/`/g, "") ?? "";
    return declared === pkg;
  } catch {
    return false;
  }
}

async function findByName(target: FileTarget): Promise<string | null> {
  const name = target.path.split("/").pop() ?? target.path;
  try {
    const hits = await call(commands.findFiles(name, 50));
    const tail = target.path.replace(/^\.?\//, "");
    const exact = hits.find((h) => h.relPath === tail || h.relPath.endsWith(`/${tail}`));
    if (exact) return exact.path;
    const named = hits.filter((h) => h.relPath.split("/").pop() === name);
    // A stack frame names its class: a same-named file of another package is not it.
    if (target.className) {
      const pkg = packageOf(target.className);
      for (const h of named) if (await declaresPackage(h.path, pkg)) return h.path;
      return null;
    }
    return named[0]?.path ?? null;
  } catch {
    return null;
  }
}

const TYPE_KINDS = new Set(["class", "interface", "enum", "struct", "trait"]);

/**
 * Library / JDK classes: the source the language server has for them (attached
 * sources or decompiled), opened as a read-only virtual document.
 */
async function findLibraryClass(className: string): Promise<string | null> {
  const outer = className.split("$")[0]!;
  const simple = outer.slice(outer.lastIndexOf(".") + 1);
  const pkg = packageOf(outer);
  try {
    const symbols = await call(commands.lspWorkspaceSymbols(nextRequestId(), simple));
    const hit = symbols.find((s) => s.name === simple && TYPE_KINDS.has(s.kind) && (s.container ?? "") === pkg);
    return hit ? (hit.location.uri ?? hit.location.path) : null;
  } catch {
    return null;
  }
}

/** Absolute run directory of a config (`cwd` is relative to the project root). */
export function runDirectory(cwd: string | null | undefined): string {
  const root = useProject.getState().project?.root ?? "/";
  return cwd ? joinPath(root, cwd) : root;
}

export async function resolveTarget(target: FileTarget, cwd: string): Promise<string | null> {
  if (target.resolve === "path") {
    const candidate = joinPath(cwd, target.path);
    if (await exists(candidate)) return candidate;
    // Paths printed relative to the project root (cargo in a workspace member, etc.).
    const root = useProject.getState().project?.root;
    if (root && !target.path.startsWith("/")) {
      const fromRoot = joinPath(root, target.path);
      if (fromRoot !== candidate && (await exists(fromRoot))) return fromRoot;
    }
  }
  return (await findByName(target)) ?? (target.className ? findLibraryClass(target.className) : null);
}

/** Regular-expression search over the project's Ruby files (or the given ones). */
async function searchRuby(pattern: string, files?: string[]) {
  const out: import("@/platform/ipc").FileMatches[] = [];
  await streamSearch(
    nextRequestId(),
    {
      pattern,
      isRegex: true,
      caseSensitive: true,
      wholeWord: false,
      include: files ? [] : ["*.rb"],
      exclude: [],
      scope: files ? { kind: "files", paths: files } : { kind: "project" },
      maxMatches: 500,
    },
    (f) => out.push(f),
  );
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export async function openTarget(target: FileTarget, cwd: string, focus = true): Promise<void> {
  if (!isTauri()) return;
  if (target.resolve === "rubyTest") {
    const site = target.className
      ? await findRubyTest(searchRuby, target.className, target.path).catch(() => null)
      : null;
    if (!site) {
      notifications().notify({
        group: "run",
        level: "warning",
        title: "File not found",
        body: `${target.className ?? ""}#${target.path}`,
        key: "run-link",
      });
      return;
    }
    await editorService().openFile(site.path, { selection: { line: site.line - 1, col: 0 }, focus });
    return;
  }
  const path = await resolveTarget(target, cwd);
  if (!path && target.className) {
    // A library or JDK frame without sources: nothing to open, which is no error.
    notifications().notify({
      group: "run",
      level: "info",
      title: "No sources for this class",
      body: tx`${target.className.split("$")[0]!} is not part of the project, and no library sources are available for it.`,
      key: "run-link",
    });
    return;
  }
  if (!path) {
    notifications().notify({
      group: "run",
      level: "warning",
      title: "File not found",
      body: target.path,
      key: "run-link",
    });
    return;
  }
  const selection = target.line ? { line: target.line - 1, col: Math.max(0, (target.col ?? 1) - 1) } : undefined;
  await editorService().openFile(path, { selection, focus });
}

export async function openUrl(url: string): Promise<void> {
  try {
    if (isTauri()) {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  } catch (e) {
    notifications().notify({ group: "run", level: "error", title: "Cannot open link", body: String(e) });
  }
}
