/**
 * Navigation bar popup (⌘↑) model: the path of the active file as segments
 * (project › dirs › file › symbols at the caret) and the child list of a segment.
 */
import { isIgnoredName } from "@/platform/ignoredNames";
import type { FileEntry, OutlineItem } from "@/platform/ipc";
import { badgeKind, fileIconName } from "@/ui";

export type NavSegment =
  | { kind: "dir"; path: string; label: string; root?: boolean }
  | { kind: "file"; path: string; label: string }
  | { kind: "symbol"; path: string; label: string; item: OutlineItem };

export type NavChild =
  | { kind: "dir"; path: string; label: string }
  | { kind: "file"; path: string; label: string }
  | { kind: "symbol"; path: string; label: string; item: OutlineItem };

const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0)) || "/";
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Segments for `path`; directories from the project root, or just the parent folder outside it. */
export function navSegments(
  project: { root: string; name: string } | null,
  path: string,
  chain: readonly OutlineItem[],
  directory = false,
): NavSegment[] {
  const out: NavSegment[] = [];
  const parent = directory ? path : parentOf(path);
  if (project && (parent === project.root || parent.startsWith(project.root + "/"))) {
    out.push({ kind: "dir", path: project.root, label: project.name, root: true });
    const rel = parent.slice(project.root.length + 1);
    let dir = project.root;
    for (const part of rel ? rel.split("/") : []) {
      dir = `${dir}/${part}`;
      out.push({ kind: "dir", path: dir, label: part });
    }
  } else out.push({ kind: "dir", path: parent, label: nameOf(parent) || parent });
  if (directory) return out;
  const file = nameOf(path);
  out.push({ kind: "file", path, label: file });
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) || file : file;
  chain.forEach((item, i) => {
    // `Foo.java › Foo`: the file already names its single class.
    if (i === 0 && item.name === stem) return;
    out.push({ kind: "symbol", path, label: item.name, item });
  });
  return out;
}

export function dirChildren(entries: readonly FileEntry[]): NavChild[] {
  return entries
    .filter((e) => !isIgnoredName(e.name))
    .map(
      (e) =>
        ({
          kind: e.kind === "dir" || (e.kind === "symlink" && e.size === 0) ? "dir" : "file",
          path: e.path,
          label: e.name,
        }) as NavChild,
    );
}

/** Children of a file or symbol segment: its outline items (one level). */
export function symbolChildren(path: string, items: readonly OutlineItem[]): NavChild[] {
  return items.map((item) => ({ kind: "symbol", path, label: item.name, item }));
}

export function iconOf(x: NavSegment | NavChild): string {
  if (x.kind === "dir") return "root" in x && x.root ? "module" : "folder";
  if (x.kind === "file") return fileIconName(x.label);
  return `symbol-${badgeKind(x.item.kind)}`;
}

/** Next active segment for ←/→ (clamped). */
export function stepSegment(index: number, count: number, delta: number): number {
  return Math.max(0, Math.min(count - 1, index + delta));
}
