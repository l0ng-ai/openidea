/** Directory tree of changed files (IDEA's "Group by Directory"), single-child directory chains merged. */

export interface FileTreeNode<F> {
  key: string;
  /** Directory label (`src/app`) or file name. */
  name: string;
  file: F | null;
  /** An explicit directory entry, including empty directories. */
  directory?: F;
  children: FileTreeNode<F>[];
  /** Number of files below (1 for a file). */
  count: number;
}

export function buildFileTree<F>(
  files: readonly F[],
  relPath: (f: F) => string,
  isDirectory?: (f: F) => boolean,
): FileTreeNode<F>[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: { name: string; file: F; rel: string }[];
    entry?: F;
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const rel = relPath(f);
    const parts = rel.split("/").filter(Boolean);
    const name = parts.pop() ?? rel;
    let d = root;
    for (const p of parts) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = { dirs: new Map(), files: [] }));
      d = next;
    }
    if (isDirectory?.(f)) {
      let sub = d.dirs.get(name);
      if (!sub) d.dirs.set(name, (sub = { dirs: new Map(), files: [] }));
      sub.entry = f;
    } else d.files.push({ name, file: f, rel });
  }

  const convert = (d: Dir, prefix: string): FileTreeNode<F>[] => {
    const out: FileTreeNode<F>[] = [];
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let cur = sub;
      while (!cur.entry && cur.files.length === 0 && cur.dirs.size === 1) {
        const [n, only] = [...cur.dirs][0]!;
        label += `/${n}`;
        path += `/${n}`;
        cur = only;
      }
      const children = convert(cur, path);
      out.push({
        key: `d:${path}`,
        name: label,
        file: null,
        directory: cur.entry,
        children,
        count: children.reduce((n, c) => n + c.count, 0),
      });
    }
    for (const f of [...d.files].sort((a, b) => a.name.localeCompare(b.name)))
      out.push({ key: `f:${f.rel}`, name: f.name, file: f.file, children: [], count: 1 });
    return out;
  };
  return convert(root, "");
}

/** Keys of every directory node (for "expand all"). */
export function dirKeys<F>(nodes: readonly FileTreeNode<F>[], out: string[] = []): string[] {
  for (const n of nodes)
    if (!n.file) {
      out.push(n.key);
      dirKeys(n.children, out);
    }
  return out;
}
