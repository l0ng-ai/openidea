/**
 * IDEA's "Specify Scope" choices for the analyses (Inspect Code, Locate
 * Duplicates, Search Structurally), resolved to a backend `SearchScope`.
 */
import { activeEditor } from "@/editor/api";
import { call, commands, isTauri, type SearchScope } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { findCustomScope } from "@/platform/search";

export type ScopeKind = "project" | "directory" | "file" | "changed" | "custom";

export interface ScopeChoice {
  kind: ScopeKind;
  /** Absolute directory for `directory`. */
  directory: string;
  /** Name of the custom scope for `custom` (`@/platform/search`). */
  custom?: string;
  /** The file `file` resolved to, so a rerun inspects it again rather than the file now active. */
  file?: string;
}

export const SCOPE_LABELS: Record<ScopeKind, string> = {
  project: "Whole project",
  directory: "Module or directory",
  file: "Current file",
  changed: "Uncommitted files",
  custom: "Custom scope",
};

/** The file of the active editor, if it is a real file. */
export function currentFile(): string | null {
  const ctx = activeEditor()?.ctx;
  return ctx && !ctx.virtual ? ctx.path : null;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

/** Initial scope: the current file's directory is offered for `directory`. */
export function defaultScope(kind: ScopeKind = "project"): ScopeChoice {
  const file = currentFile();
  const root = useProject.getState().project?.root ?? "";
  return { kind, directory: file ? dirname(file) : root };
}

/** Paths of files with uncommitted changes (from Git status). */
export async function changedFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  const status = await call(commands.vcsStatus());
  return status.filter((s) => s.unstaged !== "deleted" && s.staged !== "deleted").map((s) => s.path);
}

/** A backend scope, or a message why there is none. */
export async function resolveScope(choice: ScopeChoice): Promise<SearchScope | string> {
  switch (choice.kind) {
    case "project":
      return { kind: "project" };
    case "directory":
      return choice.directory.trim() ? { kind: "directory", path: choice.directory.trim() } : "Choose a directory";
    case "file": {
      const file = choice.file ?? currentFile();
      return file ? { kind: "files", paths: [file] } : "No file is open";
    }
    case "changed": {
      let paths: string[];
      try {
        paths = await changedFiles();
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return paths.length ? { kind: "files", paths } : "There are no uncommitted files";
    }
    case "custom": {
      const scope = choice.custom ? findCustomScope(choice.custom) : null;
      return scope ? { kind: "pattern", pattern: scope.pattern } : "Choose a scope";
    }
  }
}

/** "Project", "Directory src/app", "Current file a.rs", "3 uncommitted files". */
export function describeScope(choice: ScopeChoice, scope: SearchScope): string {
  const root = useProject.getState().project?.root ?? "";
  const rel = (p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  switch (choice.kind) {
    case "project":
      return "Project";
    case "directory":
      return `Directory ${rel(choice.directory)}`;
    case "file":
      return scope.kind === "files" ? `File ${rel(scope.paths[0] ?? "")}` : "Current file";
    case "changed":
      return scope.kind === "files"
        ? `${scope.paths.length} uncommitted file${scope.paths.length === 1 ? "" : "s"}`
        : "Uncommitted files";
    case "custom":
      return `Scope '${choice.custom ?? ""}'`;
  }
}
