/**
 * Rust documentation links (rust-analyzer): intra-doc links come as rustdoc URLs —
 * `https://doc.rust-lang.org/<channel>/<crate>/<module…>/<kind>.<Name>.html[#method.<m>]`
 * for the standard library, `https://docs.rs/<package>/<version>/<crate>/…` for other crates,
 * the project's own included. They resolve through `workspace/symbol` by name, the crate and
 * module the URL names and, for a member, its type; only a unique match counts.
 */
import type { WorkspaceSymbol } from "@/platform/ipc";
import { readFileLines } from "../files";
import { symbols, unique, type DocTarget } from "./symbols";

export interface RustDocLink {
  crate: string;
  /** Module path inside the crate (`["collections", "hash", "map"]`). */
  modules: string[];
  /** Item kind as rustdoc names its page (`struct`, `fn`, `trait`…). */
  kind: string;
  name: string;
  /** `#method.push`, `#variant.None`…: that member of the item. */
  member: string | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEMBER = /^(?:method|tymethod|variant|structfield|associatedconstant|associatedtype)\.([A-Za-z_][A-Za-z0-9_]*)$/;
/** Pages of items `workspace/symbol` lists (not modules, primitives or keywords). */
const ITEM_KINDS = new Set(["struct", "enum", "trait", "union", "type", "fn", "macro", "constant", "static"]);
const TYPE_KINDS = new Set(["struct", "enum", "trait", "union", "type"]);

/** A rustdoc item URL on doc.rust-lang.org or docs.rs; null for other links. */
export function rustDocLink(href: string): RustDocLink | null {
  // Malformed URLs and escapes are no links.
  try {
    const url = new URL(href);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // doc.rust-lang.org/<channel>/<crate>/…; docs.rs/<package>/<version>/<crate>/…
    const skip = url.hostname === "doc.rust-lang.org" ? 1 : url.hostname === "docs.rs" ? 2 : -1;
    if (skip < 0 || parts.length < skip + 2) return null;
    const [crate, ...rest] = parts.slice(skip);
    const page = /^(\w+)\.(\w+)\.html$/.exec(rest.pop()!);
    if (!page || !ITEM_KINDS.has(page[1]!) || ![crate, ...rest].every((p) => IDENT.test(p!))) return null;
    const member = MEMBER.exec(decodeURIComponent(url.hash.slice(1)))?.[1] ?? null;
    return { crate: crate!, modules: rest, kind: page[1]!, name: page[2]!, member };
  } catch {
    return null;
  }
}

/**
 * Whether `path` can be `link`'s module of its crate: the module's file or a file under its
 * directory. Files of the standard library and of downloaded crates also have to be that crate;
 * the project's own crates can't be told apart by path.
 */
export function inModule(path: string, link: Pick<RustDocLink, "crate" | "modules">): boolean {
  const m = /^(.*\/)?([^/]+)\/src\/(.*)$/.exec(path);
  if (!m) return false;
  const [, parent = "", dir, file] = m;
  const crateDir = link.crate.replace(/_/g, "[-_]");
  const packaged = /\/(?:registry\/src\/[^/]+|library\/vendor)\/$/.test(parent);
  if (/\/library\/$/.test(parent) ? dir !== link.crate : packaged && !new RegExp(`^${crateDir}-\\d`).test(dir!))
    return false;
  if (!link.modules.length) return true;
  const mod = link.modules.join("/");
  return file === `${mod}.rs` || file!.startsWith(`${mod}/`);
}

/** The type a member's symbol belongs to, as rust-analyzer names its container (`Vec<T, A>` → `Vec`). */
function ownerName(s: WorkspaceSymbol): string {
  return (s.container ?? "").replace(/<.*$/, "").trim();
}

/** A `use` line: rust-analyzer lists re-exports too, but the declaration is what's meant. */
async function isReexport(s: WorkspaceSymbol): Promise<boolean> {
  const line = (await readFileLines(s.location.path).catch(() => null))?.[s.location.range.start.line] ?? "";
  return /^\s*(?:pub(?:\([^)]*\))?\s+)?use\b/.test(line);
}

/** Where `link` is declared, when exactly one symbol fits it. */
export async function findRustItem(link: RustDocLink): Promise<DocTarget | null> {
  const name = link.member ?? link.name;
  // rust-analyzer's query markers: `*` searches the dependencies (instead of the workspace),
  // `#` every kind of symbol (not only types).
  // A common name (`Vec::new`) can be past rust-analyzer's 128 results; such links open in the browser.
  const all = link.member || !TYPE_KINDS.has(link.kind) ? "#" : "";
  const found = await Promise.all([symbols(`${name}${all}`), symbols(`${name}*${all}`)]);
  const hits = found
    .flat()
    .filter((s) => s.name === name && (!link.member || ownerName(s) === link.name) && inModule(s.location.path, link));
  const declared = await Promise.all(hits.map(async (s) => !(await isReexport(s))));
  return unique(hits.filter((_, i) => declared[i]));
}
