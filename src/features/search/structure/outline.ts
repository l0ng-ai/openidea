import type { OutlineItem, Pos, Visibility } from "@/platform/ipc";
import { matchText } from "../common/rank";
import { typeKey, type InheritedMember } from "./inherited";

export interface OutlineNode {
  key: string;
  item: OutlineItem;
  children: OutlineNode[];
  /** Show Inherited: a supertype's member, declared in `path` by `owner`. */
  inherited?: { path: string; owner: string };
}

/** Stable keys: parent key + name + occurrence index among same-named siblings. */
export function keyOutline(items: readonly OutlineItem[], parent = ""): OutlineNode[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item.name) ?? 0;
    seen.set(item.name, n + 1);
    const key = `${parent}/${item.kind}:${item.name}${n ? `#${n}` : ""}`;
    return { key, item, children: keyOutline(item.children ?? [], key) };
  });
}

/** Appends each type's inherited members (keyed by `typeKey`) after its own ones. */
export function withInherited(
  nodes: readonly OutlineNode[],
  inherited: ReadonlyMap<string, readonly InheritedMember[]> | null,
): OutlineNode[] {
  if (!inherited?.size) return nodes as OutlineNode[];
  return nodes.map((n) => {
    const children = withInherited(n.children, inherited);
    const extra = n.inherited ? undefined : inherited.get(typeKey(n.item));
    if (!extra?.length) return children === n.children ? n : { ...n, children };
    const seen = new Map<string, number>();
    const added = extra.map((m): OutlineNode => {
      const id = `${m.owner}:${m.item.kind}:${m.item.name}`;
      const k = seen.get(id) ?? 0;
      seen.set(id, k + 1);
      return {
        key: `${n.key}/inherited:${id}${k ? `#${k}` : ""}`,
        item: m.item,
        children: [],
        inherited: { path: m.path, owner: m.owner },
      };
    });
    return { ...n, children: [...children, ...added] };
  });
}

const VISIBILITY_RANK: Record<Visibility, number> = { public: 0, protected: 1, package: 2, private: 3 };

/** Rank for "Sort by Visibility": unknown counts as public. */
export const visibilityRank = (item: OutlineItem) => (item.visibility ? VISIBILITY_RANK[item.visibility] : 0);

export function sortOutline(nodes: readonly OutlineNode[], alphabetical: boolean, byVisibility = false): OutlineNode[] {
  if (!alphabetical && !byVisibility) return nodes as OutlineNode[];
  // Widgets keep their source order, which is how they nest on screen.
  const inSourceOrder = nodes.some((n) => n.item.kind === "widget");
  return [...nodes]
    .sort((a, b) =>
      inSourceOrder
        ? 0
        : (byVisibility ? visibilityRank(a.item) - visibilityRank(b.item) : 0) ||
          (alphabetical ? a.item.name.localeCompare(b.item.name, undefined, { sensitivity: "base" }) : 0),
    )
    .map((n) => ({ ...n, children: sortOutline(n.children, alphabetical, byVisibility) }));
}

const FIELD_KINDS = new Set(["field", "property"]);

export interface OutlineViewFilter {
  /** IDEA's "Show Fields": fields and properties. */
  fields: boolean;
  /** IDEA's "Show Non-Public": private / protected / package symbols. */
  nonPublic: boolean;
}

/** Hides filtered-out symbols together with their members. */
export function applyViewFilter(nodes: readonly OutlineNode[], f: OutlineViewFilter): OutlineNode[] {
  if (f.fields && f.nonPublic) return nodes as OutlineNode[];
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    if (!f.fields && FIELD_KINDS.has(n.item.kind)) continue;
    if (!f.nonPublic && n.item.visibility && n.item.visibility !== "public") continue;
    out.push({ ...n, children: applyViewFilter(n.children, f) });
  }
  return out;
}

/** Whether any symbol carries visibility (else the visibility options would do nothing). */
export function hasVisibility(items: readonly OutlineItem[]): boolean {
  return items.some((i) => !!i.visibility || hasVisibility(i.children ?? []));
}

/** Whether any symbol is a field or property. */
export function hasFields(items: readonly OutlineItem[]): boolean {
  return items.some((i) => FIELD_KINDS.has(i.kind) || hasFields(i.children ?? []));
}

const cmp = (a: Pos, b: Pos) => a.line - b.line || a.col - b.col;

function contains(item: OutlineItem, pos: Pos): boolean {
  return cmp(item.range.start, pos) <= 0 && cmp(pos, item.range.end) <= 0;
}

/** Keys from the root to the innermost symbol containing `pos` (empty if none). */
export function symbolPathAt(nodes: readonly OutlineNode[], pos: Pos): string[] {
  for (const n of nodes) {
    if (!n.inherited && contains(n.item, pos)) return [n.key, ...symbolPathAt(n.children, pos)];
  }
  return [];
}

/** Symbols from the outermost to the innermost one containing `pos` (breadcrumbs). */
export function outlinePathAt(items: readonly OutlineItem[], pos: Pos): OutlineItem[] {
  for (const item of items) {
    if (contains(item, pos)) return [item, ...outlinePathAt(item.children ?? [], pos)];
  }
  return [];
}

/** Show Only Widgets: widgets and the declarations that lead to one. */
export function onlyWidgets(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((n) => {
    const children = onlyWidgets(n.children);
    return n.item.kind === "widget" || children.length ? [{ ...n, children }] : [];
  });
}

/** The letter of a widget's badge: `_Badge` shows B. */
export const widgetLetter = (name: string) => /\p{L}/u.exec(name)?.[0]?.toUpperCase() ?? "";

/** A `build` method that creates widgets, emphasised like in the Flutter plugin. */
export const isWidgetBuild = (item: OutlineItem) =>
  item.kind === "method" && item.name.startsWith("build(") && item.children.some((c) => c.kind === "widget");

export function allKeys(nodes: readonly OutlineNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) out.push(n.key);
    allKeys(n.children, out);
  }
  return out;
}

export interface OutlineFilter {
  /** The tree to show: with `narrow`, only matches and their ancestors. */
  nodes: OutlineNode[];
  /** Match indices into each matching node's name. */
  matches: Map<string, number[]>;
  /** Matching keys in tree order (↑/↓ cycle them when not narrowing). */
  order: string[];
  /** The best-scoring match (preselected while filtering). */
  best: string | null;
}

/** The File Structure popup's speed search: matches keep their ancestors; without `narrow` nothing is hidden. */
export function filterOutline(nodes: readonly OutlineNode[], query: string, narrow: boolean): OutlineFilter {
  const q = query.trim();
  const matches = new Map<string, number[]>();
  const order: string[] = [];
  let best: string | null = null;
  let bestScore = -Infinity;
  const walk = (list: readonly OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const node of list) {
      const hit = q ? matchText(node.item.name, q, { wordAligned: true }) : null;
      if (hit) {
        matches.set(node.key, hit.indices);
        order.push(node.key);
        if (hit.score > bestScore) {
          best = node.key;
          bestScore = hit.score;
        }
      }
      const children = walk(node.children);
      if (!q || !narrow || hit || children.length) out.push(narrow ? { ...node, children } : node);
    }
    return out;
  };
  const filtered = walk(nodes);
  return { nodes: q && narrow ? filtered : (nodes as OutlineNode[]), matches, order, best };
}

/** Parent key of every node (`null` for top-level ones). */
export function parentKeys(
  nodes: readonly OutlineNode[],
  parent: string | null = null,
  out = new Map<string, string | null>(),
) {
  for (const n of nodes) {
    out.set(n.key, parent);
    parentKeys(n.children, n.key, out);
  }
  return out;
}

/** Rows a tree of `nodes` shows with the `collapsed` keys collapsed. */
export function visibleCount(nodes: readonly OutlineNode[], collapsed: ReadonlySet<string>): number {
  let n = 0;
  for (const node of nodes) n += 1 + (collapsed.has(node.key) ? 0 : visibleCount(node.children, collapsed));
  return n;
}
