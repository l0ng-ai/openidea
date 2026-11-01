import { maybeEditorService, notifications, type OpenOptions } from "@/workbench/contributions";
import { basename, dirname, relativePath, useProject } from "@/platform/project";

export interface Position {
  line: number;
  col?: number;
  endLine?: number;
  endCol?: number;
}

/** Opens `path` (optionally at a 0-based position) through the editor service. */
export async function openLocation(
  path: string,
  pos?: Position | null,
  options: Omit<OpenOptions, "selection"> = {},
): Promise<void> {
  const service = maybeEditorService();
  if (!service) {
    notifications().notify({
      group: "search",
      level: "warning",
      title: "No editor available",
      body: path,
      key: "search.noEditor",
    });
    return;
  }
  const selection = pos ? { line: pos.line, col: pos.col ?? 0, endLine: pos.endLine, endCol: pos.endCol } : undefined;
  try {
    await service.openFile(path, { focus: true, ...options, selection });
  } catch (e) {
    notifications().notify({
      group: "search",
      level: "error",
      title: `Cannot open ${basename(path)}`,
      body: String(e),
    });
  }
}

export function projectRoot(): string | null {
  return useProject.getState().project?.root ?? null;
}

export function relPath(path: string): string {
  const root = projectRoot();
  return root ? relativePath(root, path) : path;
}

/** Directory part of a project-relative path ("" for the root). */
export function relDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export { basename, dirname };

export { badgeKind } from "@/ui/symbolKind";

const TYPE_KINDS = new Set(["class", "interface", "struct", "enum", "trait", "typeAlias"]);
export const isTypeKind = (kind: string) => TYPE_KINDS.has(kind);

const CALLABLE = new Set(["function", "method", "constructor"]);
/** Display name, IDEA style: callables get `()`. */
export function symbolDisplayName(name: string, kind: string): string {
  return CALLABLE.has(kind) && !name.endsWith(")") ? `${name}()` : name;
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Open persistent tabs in list order, then restore the lead's focus and position. */
export async function openInListOrder<T>(
  items: readonly T[],
  lead: T | undefined,
  open: (item: T, options: Omit<OpenOptions, "selection">) => Promise<void>,
  side = false,
  afterOpen?: () => Promise<void>,
): Promise<void> {
  for (const item of items) await open(item, { preview: false, focus: false, side });
  await afterOpen?.();
  const target = lead && items.includes(lead) ? lead : items.at(-1);
  if (target) await open(target, { preview: false, focus: true, side });
}
