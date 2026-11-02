/**
 * Code navigation contributed by plugins (`[[contributes.code-navigation]]`):
 * per file, text ranges that navigate (links) and gutter icons (markers), each
 * with targets in a file or a database table. Pure helpers of the feature.
 */
import type {
  CodeNavigationDecl,
  DataSource,
  Location,
  PluginNavLink,
  PluginNavMarker,
  PluginNavTarget,
} from "@/bindings";
import { basename, relativePath } from "@/platform/project";

/** Compiles a project-relative glob (`*`, `**`, `?`) into a matcher of project-relative paths. */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${re}$`);
  return (p) => regex.test(p);
}

export type NavTarget = PluginNavTarget;
export type NavLink = PluginNavLink;
export type NavMarker = PluginNavMarker;

/** What the providers know about one file, merged. */
export interface FileNavigation {
  links: NavLink[];
  markers: NavMarker[];
}

/** Whether the provider's `files` globs cover `path` (absolute) of the project at `root`. */
export function matchesFile(decl: Pick<CodeNavigationDecl, "files">, root: string, path: string): boolean {
  if (!path.startsWith(`${root}/`)) return false;
  const relative = relativePath(root, path);
  return (decl.files ?? []).some((pattern) => globMatcher(pattern)(relative));
}

/** Whether a change to `path` affects a file whose provider read `deps` (files or directories). */
export function dependsOn(deps: readonly string[], path: string): boolean {
  return deps.some((d) => d === path || path.startsWith(`${d}/`));
}

/**
 * The link under `col` (0-based UTF-16 column) of `line` (1-based), the
 * narrowest when links nest; the end column counts as on the link, like the
 * caret right after an identifier.
 */
export function linkAt(links: readonly NavLink[], line: number, col: number): NavLink | null {
  let best: NavLink | null = null;
  for (const l of links) {
    if (l.line !== line || col < l.from || col > l.to) continue;
    if (!best || l.to - l.from < best.to - best.from) best = l;
  }
  return best;
}

/** The editor location of a file target (lines and columns become 0-based). */
export function targetLocation(t: NavTarget): Location | null {
  if (!t.file) return null;
  const pos = { line: Math.max(0, (t.line ?? 1) - 1), col: Math.max(0, t.col ?? 0) };
  return { path: t.file, range: { start: pos, end: pos } };
}

/** Chooser label of a target: its title, else the table or file name. */
export function targetLabel(t: NavTarget): string {
  if (t.title) return t.title;
  if (t.table) return t.schema ? `${t.schema}.${t.table}` : t.table;
  return t.file ? basename(t.file) : "";
}

/**
 * Schema a table target without `schema` opens in: the data source's resolved
 * default (from its completion model), its configured one, else the driver's.
 */
export function defaultSchemaOf(source: DataSource, resolved?: string | null): string {
  if (resolved) return resolved;
  if (source.options?.defaultSchema) return source.options.defaultSchema;
  switch (source.driver) {
    case "postgres":
      return "public";
    case "sqlite":
      return "main";
    case "sqlServer":
      return "dbo";
    case "mysql":
      return source.database ?? "";
    default:
      return "";
  }
}
