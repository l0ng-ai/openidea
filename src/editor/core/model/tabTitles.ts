/**
 * IDEA-style editor tab titles for files that share a name: the nearest parent
 * directory that tells them apart is shown after the name (`lib.rs — ide-lsp`
 * for `crates/ide-lsp/src/lib.rs` next to `crates/ide-vcs/src/lib.rs`).
 */

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Parent directory names of `path`, nearest first. */
function parents(path: string): string[] {
  return path.split("/").slice(0, -1).filter(Boolean).reverse();
}

/**
 * For every path whose file name occurs more than once in `paths`, the
 * distinguishing directory hint. Paths with a unique name are absent.
 */
export function disambiguateTitles(paths: readonly string[], titleOf = baseName): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const p of new Set(paths)) {
    const name = titleOf(p);
    const list = groups.get(name);
    if (list) list.push(p);
    else groups.set(name, [p]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const dirs = group.map(parents);
    group.forEach((path, i) => {
      const own = dirs[i]!;
      let hint: string | null = null;
      for (let depth = 0; depth < own.length; depth++) {
        const seg = own[depth]!;
        if (dirs.every((other, j) => j === i || other[depth] !== seg)) {
          hint = seg;
          break;
        }
      }
      if (hint === null) {
        // No single directory is unique: the shortest distinguishing parent path.
        const suffix = (d: string[], k: number) => d.slice(0, k).reverse().join("/");
        for (let k = 2; k <= own.length && hint === null; k++) {
          const mine = suffix(own, k);
          if (dirs.every((other, j) => j === i || suffix(other, k) !== mine)) hint = mine;
        }
      }
      out.set(path, hint ?? (own.length ? own.slice().reverse().join("/") : "/"));
    });
  }
  return out;
}
