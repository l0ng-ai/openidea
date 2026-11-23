import type { FileMatches } from "@/platform/ipc";
import { basename, relDir } from "../common/open";
import { countFileMatches } from "./session";
import type { UsageGroup } from "./replaceFlow";

export type Node =
  | { kind: "dir"; key: string; label: string; count: number; children: Node[] }
  | { kind: "file"; key: string; path: string; name: string; dir: string; count: number; children: Node[] }
  | {
      kind: "match";
      key: string;
      path: string;
      line: number;
      col: number;
      endCol: number;
      text: string;
      /** Column of `text` in the real line. */
      textCol: number;
      ranges: Array<[number, number]>;
      starts: Array<{ line: number; col: number }>;
    };

type FileNode = Node & { kind: "file" };

function fileNode(f: FileMatches): FileNode {
  const children: Node[] = f.matches.map((m) => {
    const lead = m.text.length - m.text.trimStart().length;
    const text = m.text.slice(lead).trimEnd();
    const first = m.ranges[0] ?? [0, 0];
    return {
      kind: "match",
      key: `m:${f.path}:${m.line}:${first[0] + m.textOffset}`,
      path: f.path,
      line: m.line,
      col: first[0] + m.textOffset,
      endCol: first[1] + m.textOffset,
      text,
      textCol: lead + m.textOffset,
      ranges: m.ranges
        .map(([s, e]) => [Math.max(0, s - lead), Math.min(text.length, e - lead)] as [number, number])
        .filter(([s, e]) => e > s),
      starts: m.ranges.map(([s]) => ({ line: m.line, col: s + m.textOffset })),
    };
  });
  return {
    kind: "file",
    key: `f:${f.path}`,
    path: f.path,
    name: basename(f.relPath),
    dir: relDir(f.relPath),
    count: countFileMatches(f),
    children,
  };
}

/** `old` and `add` are sorted by `cmp`; ties keep `old` first, so the result equals a stable sort of both. */
function mergeSorted<T>(old: readonly T[], add: T[], cmp: (a: T, b: T) => number): T[] {
  if (!add.length) return old.slice();
  add.sort(cmp);
  const out: T[] = [];
  let from = 0;
  let i = 0;
  while (i < add.length) {
    // First `old` entry greater than add[i].
    let lo = from;
    let hi = old.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(old[mid]!, add[i]!) <= 0) lo = mid + 1;
      else hi = mid;
    }
    for (let k = from; k < lo; k++) out.push(old[k]!);
    from = lo;
    out.push(add[i++]!);
  }
  for (let k = from; k < old.length; k++) out.push(old[k]!);
  return out;
}

interface FlatEntry {
  rel: string;
  node: FileNode;
}

interface DirEntry {
  key: string;
  label: string;
  count: number;
  children: Node[];
  node: Node | null;
}

/**
 * Streamed file matches as file → line nodes, flat and sorted by path (IDEA's
 * default), or under their directory with `groupByDirectory`.
 *
 * `sync` is incremental: the streamed list only ever grows at its end, so a call
 * builds nodes for the new files alone and merges them into the sorted result,
 * making the cost of a whole stream linear in the number of files. A list that
 * is not an extension of the previous one is rebuilt from scratch.
 */
export class FindTreeBuilder {
  /** Every node by key, kept in step with `sync`. */
  readonly byKey = new Map<string, Node>();
  /** Keys of every node that has children (files, directories). */
  readonly expandable = new Set<string>();
  readonly filesByPath = new Map<string, FileMatches>();
  private roots: Node[] = [];
  private built = 0;
  private first: FileMatches | null = null;
  private last: FileMatches | null = null;
  private flat: FlatEntry[] = [];
  private dirs = new Map<string, DirEntry>();
  private dirList: DirEntry[] = [];

  constructor(private readonly groupByDirectory = false) {}

  /** Roots for `files`; the same array while nothing was appended. */
  sync(files: readonly FileMatches[]): Node[] {
    if (this.built && (files.length < this.built || files[0] !== this.first || files[this.built - 1] !== this.last))
      this.reset();
    if (files.length === this.built) return this.roots;
    const fresh: FlatEntry[] = [];
    const newDirs: DirEntry[] = [];
    const touched = new Set<DirEntry>();
    for (let i = this.built; i < files.length; i++) {
      const f = files[i]!;
      const file = fileNode(f);
      this.filesByPath.set(f.path, f);
      this.byKey.set(file.key, file);
      this.expandable.add(file.key);
      for (const m of file.children) this.byKey.set(m.key, m);
      if (!this.groupByDirectory) {
        fresh.push({ rel: file.dir ? `${file.dir}/${file.name}` : file.name, node: file });
        continue;
      }
      let d = this.dirs.get(file.dir);
      if (!d) {
        d = { key: `d:${file.dir}`, label: file.dir || "/", count: 0, children: [], node: null };
        this.dirs.set(file.dir, d);
        newDirs.push(d);
      }
      d.children.push(file);
      d.count += file.count;
      touched.add(d);
    }
    if (files.length) {
      this.first = files[0]!;
      this.last = files[files.length - 1]!;
    }
    this.built = files.length;
    if (!this.groupByDirectory) {
      this.flat = mergeSorted(this.flat, fresh, (a, b) => a.rel.localeCompare(b.rel));
      this.roots = this.flat.map((e) => e.node);
      return this.roots;
    }
    // A directory that gained files becomes a new node, so rows showing its count update.
    for (const d of touched) {
      d.node = { kind: "dir", key: d.key, label: d.label, count: d.count, children: d.children.slice() };
      this.byKey.set(d.key, d.node);
      this.expandable.add(d.key);
    }
    this.dirList = mergeSorted(this.dirList, newDirs, (a, b) => a.label.localeCompare(b.label));
    this.roots = this.dirList.map((d) => d.node!);
    return this.roots;
  }

  private reset() {
    this.byKey.clear();
    this.expandable.clear();
    this.filesByPath.clear();
    this.roots = [];
    this.built = 0;
    this.first = this.last = null;
    this.flat = [];
    this.dirs.clear();
    this.dirList = [];
  }
}

export function buildFindTree(files: readonly FileMatches[], groupByDirectory = false): Node[] {
  return new FindTreeBuilder(groupByDirectory).sync(files);
}

/** The usages under a node (itself for a match). */
export function nodeGroups(node: Node): UsageGroup[] {
  if (node.kind === "match") return [{ key: node.key, path: node.path, starts: node.starts }];
  return node.children.flatMap(nodeGroups);
}

export function allExpandableKeys(nodes: readonly Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.kind === "match") continue;
    out.add(n.key);
    allExpandableKeys(n.children, out);
  }
  return out;
}
