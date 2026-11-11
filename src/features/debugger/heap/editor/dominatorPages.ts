import type { HeapObjectRow } from "@/platform/ipc";

/** Rows per request: a dominator can hold tens of thousands of objects, which arrive a page at a time. */
export const PAGE = 100;

export const ROOT = "root";

export type DominatorNode =
  | { kind: "object"; key: string; row: HeapObjectRow }
  | { kind: "more"; key: string; parent: string }
  | { kind: "error"; key: string; text: string };

/** The loaded children of one node (`ROOT` for the top level); `parent` is the object asked for, `null` at the top. */
export interface DominatorPage {
  parent: number | null;
  rows: HeapObjectRow[];
  total: number;
  loadingMore: boolean;
  error: string | null;
}

export type DominatorPages = Readonly<Record<string, DominatorPage>>;

export const nodeKey = (row: HeapObjectRow): string => `o${row.object}`;

/** The rows under `parent`, then a "Show more" row while the host has more, or why the last page failed. */
export function childNodes(pages: DominatorPages, parent: string): DominatorNode[] | undefined {
  const page = pages[parent];
  if (!page) return undefined;
  const nodes: DominatorNode[] = page.rows.map((row) => ({ kind: "object", key: nodeKey(row), row }));
  if (page.error !== null) nodes.push({ kind: "error", key: `error:${parent}`, text: page.error });
  else if (page.rows.length < page.total) nodes.push({ kind: "more", key: `more:${parent}`, parent });
  return nodes;
}

/** `pages` with a page that arrived at `offset` (0 replaces what was loaded, anything else appends). */
export function withPage(
  pages: DominatorPages,
  key: string,
  parent: number | null,
  offset: number,
  answer: { rows: HeapObjectRow[]; total: number },
): DominatorPages {
  const rows = offset === 0 ? answer.rows : [...(pages[key]?.rows ?? []), ...answer.rows];
  return { ...pages, [key]: { parent, rows, total: answer.total, loadingMore: false, error: null } };
}

export function withError(pages: DominatorPages, key: string, parent: number | null, error: string): DominatorPages {
  const page = pages[key];
  return { ...pages, [key]: { parent, rows: page?.rows ?? [], total: page?.total ?? 0, loadingMore: false, error } };
}
