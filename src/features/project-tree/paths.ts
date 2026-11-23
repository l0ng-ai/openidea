/** POSIX path helpers for backend paths (the backend always reports `/`-separated absolute paths). */
import { tx } from "@/platform/i18n";
import { ipcPath, isSameOrInside } from "@/platform/paths";
export { isSameOrInside } from "@/platform/paths";

export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function isInside(path: string, ancestor: string): boolean {
  return path !== ancestor && isSameOrInside(path, ancestor);
}

/**
 * `path => ancestors.some((a) => isSameOrInside(path, a))`, answered by looking up the path and each
 * of its parent folders in a set instead of comparing against every ancestor.
 */
export function insideAnyOf(ancestors: readonly string[]): (path: string) => boolean {
  if (!ancestors.length) return () => false;
  const same = new Set<string>();
  const below = new Set<string>();
  for (const a of ancestors) {
    const n = ipcPath(a);
    same.add(n);
    below.add(n.endsWith("/") ? n : `${n}/`);
  }
  return (path) => {
    const n = ipcPath(path);
    if (same.has(n)) return true;
    for (let i = n.indexOf("/"); i >= 0; i = n.indexOf("/", i + 1)) if (below.has(n.slice(0, i + 1))) return true;
    return false;
  };
}

/** Path relative to `root` (`""` for the root itself); `path` unchanged when outside. */
export function relativeTo(root: string, path: string): string {
  if (path === root) return "";
  return isInside(path, root) ? path.slice(root.length + (root.endsWith("/") ? 0 : 1)) : path;
}

/** Ancestor directories of `path` from `root` (inclusive) down to the parent of `path`. */
export function ancestorsWithin(root: string, path: string): string[] {
  if (!isInside(path, root)) return [];
  const out: string[] = [];
  for (let p = parentOf(path); isSameOrInside(p, root); p = parentOf(p)) {
    out.unshift(p);
    if (p === root || p === "/") break;
  }
  return out;
}

/** Replaces the home directory prefix with `~`, as IDEA shows paths. */
export function tildify(path: string, home: string | null | undefined): string {
  if (!home || home === "/") return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === h) return "~";
  return path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

/** Splits `name.ext` (dotfiles have no extension: `.gitignore` → [".gitignore", ""]). */
export function splitExtension(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

/** Finder-style non-conflicting name: `Foo.kt` → `Foo copy.kt` → `Foo copy 2.kt`. */
export function uniqueName(name: string, taken: (candidate: string) => boolean, isDir = false): string {
  if (!taken(name)) return name;
  const [stem, ext] = isDir ? [name, ""] : splitExtension(name);
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

export interface NameCheck {
  /** Error message, or null when the name is acceptable. */
  error: string | null;
  /** Non-fatal hint (e.g. leading/trailing spaces). */
  warning?: string;
}

export interface ValidateOptions {
  /** Names already present in the target directory. */
  siblings: Iterable<string>;
  /** Allow `a/b/c` (creates intermediate directories). */
  allowNested?: boolean;
  /** Current name when renaming (renaming to itself or a case variant is fine). */
  current?: string;
  /** Compare names case-insensitively (macOS / Windows default file systems). */
  caseInsensitive?: boolean;
  /** Apply Windows naming rules. */
  windows?: boolean;
}

const WINDOWS_INVALID = /[<>:"|?*\\]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Validates a file / folder name typed into the inline editor. */
export function validateName(raw: string, opts: ValidateOptions): NameCheck {
  const name = raw;
  if (!name.trim()) return { error: "Name cannot be empty" };
  if (name.includes("\0")) return { error: "Name contains an invalid character" };
  if (name.startsWith("/")) return { error: "Name cannot start with '/'" };
  const segments = name.split("/");
  if (segments.length > 1 && !opts.allowNested) return { error: "Name cannot contain '/'" };
  for (const seg of segments) {
    if (!seg) return { error: "Name contains an empty path segment" };
    if (seg === "." || seg === "..") return { error: `'${seg}' is not a valid name` };
    if (opts.windows && (WINDOWS_INVALID.test(seg) || WINDOWS_RESERVED.test(seg)))
      return { error: `'${seg}' is not a valid file name` };
    if (opts.windows && (seg.endsWith(".") || seg.endsWith(" ")))
      return { error: tx("Windows file and folder names cannot end with a period or space") };
    if (seg.length > 255) return { error: "Name is too long" };
  }
  const fold = (s: string) => (opts.caseInsensitive ? s.toLowerCase() : s);
  const first = fold(segments[0]!);
  const current = opts.current !== undefined ? fold(opts.current) : undefined;
  if (opts.current !== undefined && name === opts.current) return { error: null };
  for (const s of opts.siblings) {
    if (fold(s) !== first) continue;
    if (current !== undefined && fold(s) === current) continue;
    // A nested path may go through an existing directory; the backend reports a real conflict.
    if (segments.length > 1) continue;
    return { error: `'${segments[0]}' already exists` };
  }
  const warning = name !== name.trim() ? "Name has leading or trailing spaces" : undefined;
  return { error: null, warning };
}

/** Package flavour of New › Package (JVM, dotted) / New › Python Package (`__init__.py`). */
export type PackageKind = "jvm" | "python";

const JAVA_KEYWORDS = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends " +
    "false final finally float for goto if implements import instanceof int interface long native new null package " +
    "private protected public return short static strictfp super switch synchronized this throw throws transient " +
    "true try void volatile while"
  ).split(" "),
);
const PY_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally for from " +
    "global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" "),
);

/**
 * Folder segments of a dotted package name (`com.acme.util` → `com/acme/util`),
 * or an error as IDEA reports it ("Not a valid package name").
 */
export function packageSegments(raw: string, kind: PackageKind): { segments: string[] | null; error: string | null } {
  const name = raw.trim();
  if (!name) return { segments: null, error: "Name cannot be empty" };
  const segments = name.split(".");
  const ident = kind === "jvm" ? /^[A-Za-z_$][\w$]*$/ : /^[A-Za-z_]\w*$/;
  const keywords = kind === "jvm" ? JAVA_KEYWORDS : PY_KEYWORDS;
  for (const seg of segments)
    if (!ident.test(seg) || keywords.has(seg)) return { segments: null, error: `Not a valid package name: '${name}'` };
  return { segments, error: null };
}
