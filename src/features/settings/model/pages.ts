/**
 * Settings tree + search. Pages come from `useSettingsPages` (built-ins are
 * registered the same way). Nesting: a page whose dotted id extends another
 * registered page's id goes under it (`languages.servers` under `languages`);
 * otherwise under a folder for its `group`, otherwise at the top level.
 */
import type { SettingsPageContribution } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";

export interface PageNode {
  key: string;
  title: string;
  /** Absent for synthesized group folders. */
  page?: SettingsPageContribution;
  children: PageNode[];
  order: number;
  /** Set by `filterPageTree`: the page itself matches (vs. kept as an ancestor). */
  matched?: boolean;
}

export const groupKey = (group: string) => `group:${group}`;

const byOrder = (a: PageNode, b: PageNode) => a.order - b.order || a.title.localeCompare(b.title);

export function buildPageTree(pages: Iterable<SettingsPageContribution>): PageNode[] {
  const list = [...pages];
  const ids = new Set(list.map((p) => p.id));
  const nodes = new Map<string, PageNode>();
  for (const p of list) nodes.set(p.id, { key: p.id, title: p.title, page: p, children: [], order: p.order ?? 100 });

  const roots: PageNode[] = [];
  const groups = new Map<string, PageNode>();
  for (const p of list) {
    const node = nodes.get(p.id)!;
    let parentId: string | undefined;
    for (let i = p.id.lastIndexOf("."); i > 0; i = p.id.lastIndexOf(".", i - 1)) {
      const prefix = p.id.slice(0, i);
      if (ids.has(prefix)) {
        parentId = prefix;
        break;
      }
    }
    if (parentId) {
      nodes.get(parentId)!.children.push(node);
    } else if (p.group) {
      let g = groups.get(p.group);
      if (!g) {
        g = { key: groupKey(p.group), title: p.group, children: [], order: node.order };
        groups.set(p.group, g);
        roots.push(g);
      }
      g.order = Math.min(g.order, node.order);
      g.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (ns: PageNode[]) => {
    ns.sort(byOrder);
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Depth-first list of nodes. */
export function flatten(nodes: readonly PageNode[]): PageNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Breadcrumb titles from the root to `key`. */
export function breadcrumb(nodes: readonly PageNode[], key: string): string[] {
  for (const n of nodes) {
    if (n.key === key) return [n.title];
    const sub = breadcrumb(n.children, key);
    if (sub.length) return [n.title, ...sub];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Search

/** Lower-cased words of the query. */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term occurs in at least one of the texts. */
export function matchesTerms(texts: readonly string[], terms: readonly string[]): boolean {
  if (!terms.length) return true;
  // Translated texts are searched alongside the English ones.
  const hay = texts.flatMap((t) => [t.toLowerCase(), tx(t).toLowerCase()]);
  return terms.every((term) => hay.some((h) => h.includes(term)));
}

/**
 * How well a page's title answers the query: 0 when it is the query, 1 when it starts with
 * it, null otherwise (English or translated title).
 */
export function titleRank(node: PageNode, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q || !node.page) return null;
  const titles = [node.title.toLowerCase(), tx(node.title).toLowerCase()];
  if (titles.includes(q)) return 0;
  if (titles.some((title) => title.startsWith(q))) return 1;
  return null;
}

/** The matching page whose title answers the query best (see {@link titleRank}), if any. */
export function titledPage(nodes: readonly PageNode[], query: string): PageNode | null {
  let best: PageNode | null = null;
  let bestRank = Infinity;
  for (const n of flatten(nodes)) {
    const rank = n.matched ? titleRank(n, query) : null;
    if (rank !== null && rank < bestRank) {
      best = n;
      bestRank = rank;
    }
  }
  return best;
}

/** Indices of `text` covered by any term (for highlighting option labels), or null. */
export function highlightIndices(text: string, query: string): number[] | null {
  const terms = queryTerms(query);
  if (!terms.length) return null;
  const lower = text.toLowerCase();
  const hit = new Set<number>();
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) {
      for (let i = 0; i < term.length; i++) hit.add(at + i);
    }
  }
  return hit.size ? [...hit].sort((a, b) => a - b) : null;
}

/** Whether one option label matches the query (any term, so partial queries still light up rows). */
export function labelMatches(text: string, query: string): boolean {
  return highlightIndices(text, query) !== null || highlightIndices(tx(text), query) !== null;
}

/** Search texts of a page: title, group, keywords and its registered option labels. */
export function pageTexts(page: SettingsPageContribution, labels: readonly string[] = []): string[] {
  return [page.title, page.group ?? "", ...(page.keywords ?? []), ...labels];
}

/**
 * Filters the tree to pages matching the query (a page also matches when the
 * combined title path matches, e.g. "editor font"). Ancestors of matches are kept.
 */
export function filterPageTree(
  nodes: readonly PageNode[],
  query: string,
  labelsFor: (pageId: string) => readonly string[] = () => [],
  path: readonly string[] = [],
): PageNode[] {
  const terms = queryTerms(query);
  if (!terms.length) return [...nodes];
  const out: PageNode[] = [];
  for (const n of nodes) {
    const trail = [...path, n.title];
    const children = filterPageTree(n.children, query, labelsFor, trail);
    const self = n.page ? matchesTerms([...trail, ...pageTexts(n.page, labelsFor(n.page.id))], terms) : false;
    if (self || children.length) out.push({ ...n, children, matched: self });
  }
  return out;
}
