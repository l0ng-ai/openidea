/**
 * Structure › Show Inherited: members of each type's supertypes (LSP type
 * hierarchy + the supertypes' document symbols), minus the ones the type
 * itself or a nearer supertype declares.
 */
import type { HierarchyItem, OutlineItem, Pos } from "@/platform/ipc";
import { isTypeKind } from "../common/open";

export interface InheritedMember {
  item: OutlineItem;
  /** File (or virtual document URI) declaring the member. */
  path: string;
  /** Name of the supertype declaring it. */
  owner: string;
}

export interface InheritedDeps {
  supertypes: (path: string, pos: Pos) => Promise<HierarchyItem[]>;
  outline: (path: string) => Promise<OutlineItem[]>;
}

/** `beta(int)` (jdtls) and `beta` name the same member. */
const baseName = (name: string) => name.replace(/\s*[(<].*$/, "");
const SKIPPED = new Set(["constructor"]);

/** Key of a type in the current file: its identifier's position. */
export const typeKey = (item: OutlineItem) => `${item.selection_range.start.line}:${item.selection_range.start.col}`;

/** Every type declared in `items`, nested ones included. */
export function typesIn(items: readonly OutlineItem[], out: OutlineItem[] = []): OutlineItem[] {
  for (const i of items) {
    if (isTypeKind(i.kind)) out.push(i);
    typesIn(i.children ?? [], out);
  }
  return out;
}

/** The type declared at `at` in `outline` (matched by its identifier's line). */
function typeAt(outline: readonly OutlineItem[], at: Pos): OutlineItem | null {
  for (const i of outline) {
    if (isTypeKind(i.kind) && i.selection_range.start.line === at.line) return i;
    if (i.range.start.line <= at.line && at.line <= i.range.end.line) {
      const deeper = typeAt(i.children ?? [], at);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** Inherited members of `type` (declared in `path`), nearest supertypes first, up to `depth` levels. */
export async function inheritedMembers(
  path: string,
  type: OutlineItem,
  deps: InheritedDeps,
  depth = 6,
): Promise<InheritedMember[]> {
  const own = new Set(type.children.map((c) => baseName(c.name)));
  const out: InheritedMember[] = [];
  const seen = new Set<string>();
  const outlines = new Map<string, Promise<OutlineItem[]>>();
  const outlineOf = (p: string) => {
    let o = outlines.get(p);
    if (!o) outlines.set(p, (o = deps.outline(p).catch(() => [] as OutlineItem[])));
    return o;
  };
  let level: Array<{ path: string; pos: Pos }> = [{ path, pos: type.selection_range.start }];
  for (let d = 0; d < depth && level.length; d++) {
    const next: Array<{ path: string; pos: Pos }> = [];
    // oxlint-disable-next-line no-await-in-loop -- levels are sequential; supertype queries within a level are parallel
    const supersLists = await Promise.all(
      level.map((t) => deps.supertypes(t.path, t.pos).catch(() => [] as HierarchyItem[])),
    );
    // Walk in level order so dedupe (`seen`) and nearest-declaration hiding (`own`) keep their meaning.
    const toOutline: HierarchyItem[] = [];
    for (const supers of supersLists) {
      for (const s of supers) {
        const key = `${s.path}:${s.selectionRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ path: s.path, pos: s.selectionRange.start });
        toOutline.push(s);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- levels are sequential; outlines within a level are parallel
    const outlineLists = await Promise.all(toOutline.map((s) => outlineOf(s.path)));
    toOutline.forEach((s, i) => {
      const decl = typeAt(outlineLists[i]!, s.selectionRange.start);
      // Overloads within one supertype all show; a nearer declaration hides farther ones.
      const declared: string[] = [];
      for (const m of decl?.children ?? []) {
        const name = baseName(m.name);
        if (SKIPPED.has(m.kind) || isTypeKind(m.kind) || own.has(name)) continue;
        declared.push(name);
        out.push({ item: m, path: s.path, owner: baseName(s.name) });
      }
      declared.forEach((n) => own.add(n));
    });
    level = next;
  }
  return out;
}
