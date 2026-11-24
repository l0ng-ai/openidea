/**
 * Cells a result page carries only the start of. The backend cuts a cell longer than
 * `CELL_LIMIT` and lists it in the result's `truncated`, so a page of wide values stays small;
 * the whole value is read again when it is needed (the grid's copy, edit and value panel, the
 * export) and kept beside the result for as long as it lives.
 */
import { useSyncExternalStore } from "react";
import type { DbQueryResult } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import type { Cell } from "./model";
import { readResultPage, readResultRow, type ResultTab } from "./store";

/** Rows with cut cells beyond which the page is read once instead of row by row. */
const ROWWISE_LIMIT = 8;

const key = (row: number, col: number) => `${row}:${col}`;

/** The whole text of cut cells that were read, by result. */
const whole = new WeakMap<DbQueryResult, Map<string, string>>();
const listeners = new Set<() => void>();
let version = 0;

/** Re-renders what reads the cells of results when one is loaded. */
export function useCutCells(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => version,
  );
}

/** The cells of `r` the backend cut (an older remote host sends none). */
const cutOf = (r: DbQueryResult) => r.truncated ?? [];

/** The text of cell (`row`, `col`) of `r`: its whole value once read. */
export function cellOf(r: DbQueryResult, row: number, col: number): Cell {
  return whole.get(r)?.get(key(row, col)) ?? r.rows[row]?.[col] ?? null;
}

/** The cut cell (`row`, `col`) of `r` while it shows only its start; else `null`. */
function cutCell(r: DbQueryResult, row: number, col: number) {
  if (whole.get(r)?.has(key(row, col))) return null;
  return cutOf(r).find((c) => c.row === row && c.column === col) ?? null;
}

/** The whole length (UTF-16 units) of cell (`row`, `col`) of `r` while it shows only its start; else `null`. */
export const cutLength = (r: DbQueryResult, row: number, col: number): number | null =>
  cutCell(r, row, col)?.length ?? null;

/** FNV-1a over the UTF-16 units of `text`, one step per unit: what the backend hashes a cut value with. */
export function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** Whether `r` still has a cell that shows only its start. */
export const hasCutCells = (r: DbQueryResult): boolean =>
  cutOf(r).some((c) => !whole.get(r)?.has(key(c.row, c.column)));

/** The rows of `r` with the cells that were read whole. */
export function rowsOf(r: DbQueryResult): Cell[][] {
  return r.rows.map((cells, row) => cells.map((_, col) => cellOf(r, row, col)));
}

class ResultChanged extends Error {
  constructor() {
    super(tx("The result changed since this page was read. Run the query again."));
  }
}

/**
 * Keeps the whole cells of `fresh`, the `count` rows read again from row `at` of the page `r`,
 * once they are the rows the page showed: as many rows, every other cell the same, and each cut
 * cell a value of the length and hash the backend cut it from, starting with what the page shows.
 */
function adopt(r: DbQueryResult, at: number, count: number, fresh: DbQueryResult) {
  const kept = whole.get(r) ?? new Map<string, string>();
  const names = r.columns.map((c) => c.name);
  if (fresh.columns.length !== names.length || fresh.columns.some((c, i) => c.name !== names[i]))
    throw new ResultChanged();
  if (fresh.rows.length !== count || at + count > r.rows.length) throw new ResultChanged();
  const found = new Map<string, string>();
  fresh.rows.forEach((cells, i) => {
    const row = at + i;
    if (cells.length !== names.length) throw new ResultChanged();
    cells.forEach((text, col) => {
      const cut = cutCell(r, row, col);
      if (cut === null) {
        if (text !== cellOf(r, row, col)) throw new ResultChanged();
      } else if (
        text === null ||
        text.length !== cut.length ||
        hashOf(text) !== cut.hash ||
        !text.startsWith(r.rows[row]![col] ?? "")
      )
        throw new ResultChanged();
      else found.set(key(row, col), text);
    });
  });
  for (const [k, text] of found) kept.set(k, text);
  whole.set(r, kept);
  version++;
  for (const listener of listeners) listener();
}

/** Where the rows of `tab`'s page start among the rows of its whole result. */
const firstRow = (tab: ResultTab) => (tab.page ?? 0) * (tab.pageSize ?? 0);

/**
 * Reads the whole values of the cut cells among `cells` of the page `tab` shows (what `adopt`
 * checks against the page); each result row comes back by itself unless many rows are involved.
 * The text of every requested cell follows, cut or not.
 */
export async function loadCells(tab: ResultTab, cells: ReadonlyArray<{ row: number; col: number }>): Promise<Cell[]> {
  const r = tab.outcome.result!;
  const cut = cells.filter((c) => cutLength(r, c.row, c.col) !== null);
  const rows = [...new Set(cut.map((c) => c.row))].sort((a, b) => a - b);
  if (rows.length > ROWWISE_LIMIT) adopt(r, 0, r.rows.length, await readResultPage(tab));
  // oxlint-disable-next-line no-await-in-loop -- readResultRow goes through withConnection, which can prompt for credentials; parallel reads could raise several prompts
  else for (const row of rows) adopt(r, row, 1, await readResultRow(tab, firstRow(tab) + row));
  return cells.map((c) => cellOf(r, c.row, c.col));
}

/** Reads every cut cell of the page `tab` shows (before it is exported). */
export async function loadPage(tab: ResultTab): Promise<void> {
  const r = tab.outcome.result!;
  const cells = cutOf(r)
    .filter((c) => cutLength(r, c.row, c.column) !== null)
    .map((c) => ({ row: c.row, col: c.column }));
  if (cells.length) await loadCells(tab, cells);
}
