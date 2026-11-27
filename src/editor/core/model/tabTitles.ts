/**
 * Directory hints for files that share a name: a distinguishing parent
 * directory is shown after the name (`lib.rs — ide-lsp`
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
    const nameCounts = new Map<string, number>();
    const suffixCounts = new Map<string, number>();
    const suffixes = dirs.map((names) => {
      for (const name of new Set(names)) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      let suffix = "";
      return names.map((name) => {
        suffix = suffix ? `${name}/${suffix}` : name;
        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
        return suffix;
      });
    });
    group.forEach((path, i) => {
      const name = dirs[i]!.find((segment) => nameCounts.get(segment) === 1);
      const paths = suffixes[i]!;
      const hint = name ?? paths.find((suffix, depth) => depth > 0 && suffixCounts.get(suffix) === 1);
      out.set(path, hint ?? paths.at(-1) ?? "/");
    });
  }
  return out;
}
