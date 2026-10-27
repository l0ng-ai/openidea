import type { EditorInput, OpenEditorTab, ToolWindowContribution } from "@/workbench/contributions";
import type { OutlineItem } from "@/platform/ipc";
import { formatTimestamp } from "@/platform/dateFormat";
import type { CodeToken } from "@/editor/lsp/markdown";
import { basename, relDir, symbolDisplayName } from "../common/open";
import type { RecentLocation } from "../common/locations";
import { matchText } from "../common/rank";
import { isVirtualUri, virtualContainer } from "@/platform/virtualDocs";

export interface RecentFileItem {
  path: string;
  rel: string;
  name: string;
  dir: string;
  indices: number[];
  /** Switcher: an open editor that is not a file (agent session, diff…); `path` is its input key. */
  editor?: { input: EditorInput; icon: string };
}

export function filterRecentFiles(
  paths: readonly string[],
  query: string,
  opts: { root: string | null; edited?: ReadonlySet<string>; editedOnly?: boolean },
): RecentFileItem[] {
  const out: RecentFileItem[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (opts.editedOnly && !opts.edited?.has(path)) continue;
    const rel = opts.root && path.startsWith(opts.root + "/") ? path.slice(opts.root.length + 1) : path;
    const name = basename(rel);
    let indices: number[] = [];
    if (query.trim()) {
      const hit = matchText(name, query);
      if (hit) indices = hit.indices;
      else if (!matchText(rel, query)) continue;
    }
    out.push({ path, rel, name, dir: isVirtualUri(path) ? virtualContainer(path) : relDir(rel), indices });
  }
  return out;
}

/** IDEA preselects the previous file so ⌘E ↵ toggles between the last two. */
export function initialFileIndex(items: readonly RecentFileItem[], activePath: string | null, query: string): number {
  if (!items.length) return -1;
  if (!query && items.length > 1 && items[0]!.path === activePath) return 1;
  return 0;
}

/** Switcher (⌃⇥) files: only open editors, most recently opened first. */
export function switcherPaths(recent: readonly string[], open: readonly string[]): string[] {
  const isOpen = new Set(open);
  const out = [...new Set(recent.filter((p) => isOpen.has(p)))];
  const listed = new Set(out);
  for (const p of open) if (!listed.has(p)) out.push(p);
  return out;
}

const isFileTab = (t: OpenEditorTab) => !!t.input.path && (t.input.kind === "file" || t.input.kind === "virtual");

/**
 * Switcher (⌃⇥) rows: every open editor, like IDEA (whose editors are all files). Tabs active
 * this session come first, most recent first; then the other open files in recent-files
 * order; then the other editors in tab order.
 */
export function switcherItems(
  recent: readonly string[],
  tabs: readonly OpenEditorTab[],
  query: string,
  root: string | null,
): RecentFileItem[] {
  const fileTabs = new Map(tabs.filter(isFileTab).map((t) => [t.input.path!, t]));
  const ordered = [
    ...tabs.filter((t) => t.lastActive > 0),
    ...switcherPaths(recent, [...fileTabs.keys()]).flatMap((p) => {
      const t = fileTabs.get(p)!;
      return t.lastActive > 0 ? [] : [t];
    }),
    ...tabs.filter((t) => t.lastActive === 0 && !isFileTab(t)),
  ];
  const out: RecentFileItem[] = [];
  for (const t of ordered) {
    if (isFileTab(t)) {
      out.push(...filterRecentFiles([t.input.path!], query, { root }));
      continue;
    }
    let indices: number[] = [];
    if (query.trim()) {
      const hit = matchText(t.title, query);
      if (!hit) continue;
      indices = hit.indices;
    }
    const path = t.input.path;
    const rel = path && root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    out.push({
      path: t.input.key,
      rel: rel ?? t.title,
      name: t.title,
      dir: rel ? relDir(rel) : "",
      indices,
      editor: { input: t.input, icon: t.icon },
    });
  }
  return out;
}

/**
 * Switcher selection `step` rows away from file row `base`: moving past the end
 * of one column continues in the other (files, then tool windows), like IDEA.
 */
export function switcherSelection(
  base: number,
  step: number,
  files: number,
  tools: number,
): { column: "files" | "tools"; index: number } | null {
  const n = files + tools;
  if (!n) return null;
  const at = (((base + step) % n) + n) % n;
  return at < files ? { column: "files", index: at } : { column: "tools", index: at - files };
}

const ANCHOR_ORDER = { left: 0, bottom: 1, right: 2 } as const;

export function switcherToolWindows(
  windows: Iterable<ToolWindowContribution>,
  projectOpen: boolean,
  query: string,
): Array<{ tw: ToolWindowContribution; indices: number[] }> {
  const list = [...windows]
    .filter((tw) => projectOpen || tw.requiresProject === false)
    .sort(
      (a, b) =>
        ANCHOR_ORDER[a.anchor] - ANCHOR_ORDER[b.anchor] ||
        Number(!!a.secondary) - Number(!!b.secondary) ||
        (a.order ?? 0) - (b.order ?? 0),
    );
  if (!query.trim()) return list.map((tw) => ({ tw, indices: [] }));
  const out: Array<{ tw: ToolWindowContribution; indices: number[] }> = [];
  for (const tw of list) {
    const hit = matchText(tw.title, query);
    if (hit) out.push({ tw, indices: hit.indices });
  }
  return out;
}

export function filterLocations(
  list: readonly RecentLocation[],
  query: string,
  opts: { changedOnly: boolean; root: string | null },
): Array<RecentLocation & { rel: string; nameIndices: number[] }> {
  const q = query.trim().toLowerCase();
  const out: Array<RecentLocation & { rel: string; nameIndices: number[] }> = [];
  for (const l of list) {
    if (opts.changedOnly && !l.changed) continue;
    const rel = opts.root && l.path.startsWith(opts.root + "/") ? l.path.slice(opts.root.length + 1) : l.path;
    let nameIndices: number[] = [];
    if (q) {
      const hit = matchText(basename(rel), q);
      if (hit) nameIndices = hit.indices;
      else if (!l.snippet.some((s) => s.toLowerCase().includes(q)) && !rel.toLowerCase().includes(q)) continue;
    }
    out.push({ ...l, rel, nameIndices });
  }
  return out;
}

/** IDEA's Recent Locations time: "Just now", "14 minutes ago", then the pretty timestamp ("Yesterday 22:52"). */
export function locationTime(ms: number, now = Date.now(), format: (ms: number, now: number) => string = formatTimestamp): string {
  if (!ms) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes >= 0 && minutes < 1) return "Just now";
  if (minutes >= 1 && minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return format(ms, now);
}

/** Breadcrumb of the symbols around a location ("OrderController > list()"). */
export function locationBreadcrumb(path: readonly Pick<OutlineItem, "name" | "kind">[]): string {
  return path.map((s) => symbolDisplayName(s.name, s.kind)).join(" > ");
}

export interface CodeSegment {
  text: string;
  /** Lezer `classHighlighter` classes, "" for plain text. */
  cls: string;
}

/** Splits highlight tokens of `lines.join("\n")` into per-line segments. */
export function lineSegments(lines: readonly string[], tokens: readonly CodeToken[]): CodeSegment[][] {
  const out: CodeSegment[][] = [];
  let start = 0;
  let t = 0;
  for (const line of lines) {
    const end = start + line.length;
    const segs: CodeSegment[] = [];
    let pos = start;
    while (t < tokens.length && tokens[t]!.to <= start) t++;
    for (let i = t; i < tokens.length && tokens[i]!.from < end; i++) {
      const from = Math.max(tokens[i]!.from, start);
      const to = Math.min(tokens[i]!.to, end);
      if (from > pos) segs.push({ text: line.slice(pos - start, from - start), cls: "" });
      if (to > from) segs.push({ text: line.slice(from - start, to - start), cls: tokens[i]!.cls });
      pos = Math.max(pos, to);
    }
    if (pos < end) segs.push({ text: line.slice(pos - start), cls: "" });
    out.push(segs);
    start = end + 1;
  }
  return out;
}
