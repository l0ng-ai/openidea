/**
 * Outline-based navigation: Next / Previous Method (⌃⇧↓ / ⌃⇧↑) and Super
 * Method (⌘U). The outline is the language server's document symbols, or
 * tree-sitter's without a server (`doc_outline`).
 */
import type { HierarchyItem, Location, OutlineItem, Pos, SymbolKind } from "@/platform/ipc";

const METHODS = new Set<SymbolKind>(["function", "method", "constructor"]);
const TYPES = new Set<SymbolKind>(["class", "interface", "struct", "enum", "trait", "module", "namespace"]);

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col <= b.col);
const inside = (i: OutlineItem, p: Pos) => before(i.range.start, p) && before(p, i.range.end);

/** Navigation stops of Next / Previous Method: methods and types, in document order. */
export function methodStops(outline: readonly OutlineItem[]): Pos[] {
  const out: Pos[] = [];
  const walk = (items: readonly OutlineItem[]) => {
    for (const i of items) {
      if (METHODS.has(i.kind) || TYPES.has(i.kind)) out.push(i.selection_range.start);
      walk(i.children);
    }
  };
  walk(outline);
  const key = (p: Pos) => p.line * 1e6 + p.col;
  return [...new Map(out.map((p) => [key(p), p])).values()].sort((a, b) => key(a) - key(b));
}

/** The next (dir 1) / previous (-1) stop from `caret`, comparing by line like IDEA. */
export function methodStop(outline: readonly OutlineItem[], caret: Pos, dir: 1 | -1): Pos | null {
  const stops = methodStops(outline);
  if (dir === 1) return stops.find((p) => p.line > caret.line) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) {
    const p = stops[i]!;
    if (p.line < caret.line || (p.line === caret.line && p.col < caret.col)) return p;
  }
  return null;
}

export interface CaretMember {
  /** Innermost method at the caret. */
  method: OutlineItem | null;
  /** Innermost type around the caret (around `method` when there is one). */
  type: OutlineItem | null;
}

export function memberAt(outline: readonly OutlineItem[], caret: Pos): CaretMember {
  let method: OutlineItem | null = null;
  let type: OutlineItem | null = null;
  let level: readonly OutlineItem[] = outline;
  for (;;) {
    const hit = level.find((i) => inside(i, caret));
    if (!hit) break;
    if (METHODS.has(hit.kind)) method = hit;
    else if (TYPES.has(hit.kind) && !method) type = hit;
    level = hit.children;
  }
  return { method, type };
}

/** `beta(int)` (jdtls) and `beta` name the same method. */
export const baseName = (name: string) => name.replace(/\s*[(<].*$/, "");

/** `beta(int) : void` (jdtls) is the signature `beta(int)`; plain names stay as they are. */
const signature = (name: string) => name.replace(/\s*:.*$/, "");

/** The outline node of the type declared at `item` (found by position). */
export function typeOf(outline: readonly OutlineItem[], item: HierarchyItem): OutlineItem | null {
  const at = item.selectionRange.start;
  const find = (items: readonly OutlineItem[]): OutlineItem | null => {
    for (const i of items) {
      if (TYPES.has(i.kind) && i.selection_range.start.line === at.line) return i;
      const deeper = inside(i, at) ? find(i.children) : null;
      if (deeper) return deeper;
    }
    return null;
  };
  return find(outline);
}

/**
 * Methods named `name` directly inside the type declared at `item`: the
 * overload with the same signature when the server names them with one
 * (`eat(String)`), else every method of that name.
 */
export function methodsInType(outline: readonly OutlineItem[], item: HierarchyItem, name: string): OutlineItem[] {
  const type = typeOf(outline, item);
  const bare = baseName(name);
  const named = type ? type.children.filter((c) => METHODS.has(c.kind) && baseName(c.name) === bare) : [];
  const exact = named.filter((c) => signature(c.name) === signature(name));
  return exact.length ? exact : named;
}

/**
 * Methods of the type declared at `item` that override `signature` (`save(T, int)` as jdtls names
 * it): those with the same signature, or `null` when one with the same name has another signature
 * (`save(Order)` for a generic `save(T)`) and only the server can tell whether it overrides.
 */
export function overridersInType(
  outline: readonly OutlineItem[],
  item: HierarchyItem,
  signatureName: string,
): OutlineItem[] | null {
  const type = typeOf(outline, item);
  if (!type) return null;
  const bare = baseName(signatureName);
  const named = type.children.filter((c) => METHODS.has(c.kind) && baseName(c.name) === bare);
  const exact = named.filter((c) => signature(c.name) === signature(signatureName));
  return named.length > exact.length ? null : exact;
}

export interface SuperDeps {
  supertypes: (path: string, pos: Pos) => Promise<HierarchyItem[]>;
  /** Direct subtypes, when the type hierarchy answers it (fallback for implementation requests). */
  subtypes?: (path: string, pos: Pos) => Promise<HierarchyItem[]>;
  outline: (path: string) => Promise<OutlineItem[]>;
}

export interface SuperMethod {
  location: Location;
  /** The supertype declaring it. */
  owner: HierarchyItem;
  method: OutlineItem;
}

/** Super methods of `method` (a member of the type at `typePos`), with their declaring types, nearest level first. */
export async function superMethodTargets(
  path: string,
  typePos: Pos,
  method: string,
  deps: SuperDeps,
  depth = 3,
): Promise<SuperMethod[]> {
  let level: Array<{ path: string; pos: Pos }> = [{ path, pos: typePos }];
  const seen = new Set<string>();
  for (let d = 0; d < depth && level.length; d++) {
    const next: Array<{ path: string; pos: Pos }> = [];
    const found: SuperMethod[] = [];
    for (const t of level) {
      const supers = await deps.supertypes(t.path, t.pos).catch(() => [] as HierarchyItem[]);
      for (const s of supers) {
        const key = `${s.path}:${s.selectionRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const methods = methodsInType(await deps.outline(s.path).catch(() => [] as OutlineItem[]), s, method);
        if (methods.length)
          for (const m of methods)
            found.push({ location: { path: s.path, range: m.selection_range }, owner: s, method: m });
        else next.push({ path: s.path, pos: s.selectionRange.start });
      }
    }
    if (found.length) return found;
    level = next;
  }
  return [];
}

/** Super methods of `method` (a member of the type at `typePos`), searching up to `depth` levels of supertypes. */
export async function superMethods(
  path: string,
  typePos: Pos,
  method: string,
  deps: SuperDeps,
  depth = 3,
): Promise<Location[]> {
  return (await superMethodTargets(path, typePos, method, deps, depth)).map((s) => s.location);
}
