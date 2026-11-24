/** TODO tool window grouping and search scopes. */
import type { SearchScope } from "@/platform/ipc";
import type { CustomScope } from "@/platform/search";
import type { TodoItem } from "@/platform/todo";
import { localChangedPaths, type LocalChangelist } from "@/workbench/contributions";

export interface TodoGroup {
  path: string;
  items: TodoItem[];
}

export interface TodoFilter {
  /** Keywords to show; null = all. */
  keywords: ReadonlySet<string> | null;
  /** Restrict to one file (Current File tab). */
  path?: string | null;
  /** Restrict to these files (Changes tab). */
  paths?: ReadonlySet<string>;
}

export function filterItems(items: readonly TodoItem[], f: TodoFilter): TodoItem[] {
  return f.keywords ? items.filter((i) => f.keywords!.has(i.keyword)) : [...items];
}

/** Groups by file (sorted by path), items by position; empty groups dropped. */
export function groupTodos(map: ReadonlyMap<string, readonly TodoItem[]>, f: TodoFilter): TodoGroup[] {
  const all = f.path !== undefined ? (f.path && map.has(f.path) ? [f.path] : []) : [...map.keys()];
  const paths = f.paths ? all.filter((p) => f.paths!.has(p)) : all;
  const groups: TodoGroup[] = [];
  for (const path of paths) {
    const items = filterItems(map.get(path) ?? [], f).sort((a, b) => a.line - b.line || a.col - b.col);
    if (items.length) groups.push({ path, items });
  }
  return groups.sort((a, b) => a.path.localeCompare(b.path));
}

export const countItems = (groups: readonly TodoGroup[]) => groups.reduce((n, g) => n + g.items.length, 0);

/** Backend results with live editor scans layered on top. */
export function mergeLive(
  scanned: ReadonlyMap<string, readonly TodoItem[]>,
  live: ReadonlyMap<string, readonly TodoItem[]>,
): Map<string, readonly TodoItem[]> {
  const out = new Map(scanned);
  for (const [path, items] of live) out.set(path, items);
  return out;
}

/** A scope of the "Scope Based" tab: a built-in one or a custom scope (`custom:<name>`, `@/platform/search`). */
export type TodoScope = "projectFiles" | "productionFiles" | "testFiles" | "openFiles" | `custom:${string}`;

export const BUILTIN_TODO_SCOPES: ReadonlyArray<{ value: TodoScope; label: string }> = [
  { value: "projectFiles", label: "Project Files" },
  { value: "productionFiles", label: "Project Production Files" },
  { value: "testFiles", label: "Project Test Files" },
  { value: "openFiles", label: "Open Files" },
];

/** The backend scope to scan, or null when there is nothing to scan (no open files, unknown custom scope). */
export function todoSearchScope(
  scope: TodoScope,
  custom: readonly CustomScope[],
  openPaths: readonly string[],
): SearchScope | null {
  switch (scope) {
    case "projectFiles":
      return { kind: "project" };
    case "productionFiles":
      return { kind: "fileSet", set: "production" };
    case "testFiles":
      return { kind: "fileSet", set: "test" };
    case "openFiles":
      return openPaths.length ? { kind: "files", paths: [...openPaths] } : null;
  }
  const name = scope.slice("custom:".length);
  const found = custom.find((c) => c.name === name);
  return found ? { kind: "pattern", pattern: found.pattern } : null;
}

/**
 * Files with local changes in change list `listId` (the active one when unset or
 * gone), from the VCS change lists: unversioned and ignored files belong to no list.
 */
export function changedPaths(lists: readonly LocalChangelist[], listId?: string | null): Set<string> {
  const id = lists.find((l) => l.id === listId)?.id ?? lists.find((l) => l.active)?.id ?? lists[0]?.id;
  return new Set(id ? localChangedPaths(lists, id, true) : []);
}
