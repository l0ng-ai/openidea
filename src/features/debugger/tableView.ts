/**
 * View as Table (PyCharm's View as Array / DataFrame): one window of a pandas DataFrame /
 * Series or numpy array at a time, read with `evaluate` in the paused frame. The debuggee
 * slices the object itself, so only the rows and columns on screen cross the wire.
 */
import { stringText } from "./valueText";

/** Type names debugpy reports for values the viewer can show. */
const TABLE_TYPES = new Set(["DataFrame", "Series", "ndarray"]);

export function isTableType(typeName: string | null | undefined): boolean {
  return !!typeName && TABLE_TYPES.has(typeName);
}

export const ROW_PAGE = 100;
export const COLUMN_PAGE = 30;

export interface TableWindow {
  row: number;
  column: number;
}

export interface TablePage {
  kind: "frame" | "series" | "array";
  /** The object's own shape, e.g. `[1000, 5]`. */
  shape: number[];
  rows: number;
  columns: number;
  /** One dtype per shown column for a DataFrame, else the object's single dtype. */
  dtypes: string[];
  headers: string[];
  index: string[];
  cells: string[][];
}

/** `error`: "type" (not a table), "ndim" (more than two dimensions; `ndim` says how many) or the error text. */
export type TableResult = { page: TablePage } | { error: string; ndim?: number };

// Runs in the debuggee. Cells are cut at 200 characters so one huge cell can't flood the reply.
const HELPER = `
def f(o, r0, nr, c0, nc):
    import json
    s = lambda v: str(v)[:200]
    try:
        if hasattr(o, 'iloc') and hasattr(o, 'columns'):
            k, d = 'frame', o.iloc[r0:r0 + nr, c0:c0 + nc]
            R, C = o.shape
            dt, h = [str(x) for x in d.dtypes], [s(c) for c in d.columns]
            idx, cells = [s(i) for i in d.index], [[s(v) for v in r] for r in d.itertuples(index=False, name=None)]
        elif hasattr(o, 'iloc'):
            k, d = 'series', o.iloc[r0:r0 + nr]
            R, C = len(o), 1
            dt, h = [str(o.dtype)], ['' if o.name is None else s(o.name)]
            idx, cells = [s(i) for i in d.index], [[s(v)] for v in d]
        elif hasattr(o, 'ndim') and hasattr(o, 'dtype'):
            if o.ndim > 2:
                return json.dumps({'error': 'ndim', 'ndim': o.ndim})
            k, a = 'array', (o.reshape(1, 1) if o.ndim == 0 else o)
            R, C = a.shape[0], (a.shape[1] if a.ndim == 2 else 1)
            d = a[r0:r0 + nr, c0:c0 + nc] if a.ndim == 2 else a[r0:r0 + nr].reshape(-1, 1)
            dt, h = [str(o.dtype)], [str(c0 + j) for j in range(d.shape[1])] if a.ndim == 2 else ['0']
            idx, cells = [str(r0 + i) for i in range(d.shape[0])], [[s(v) for v in r] for r in d]
        else:
            return json.dumps({'error': 'type'})
        return json.dumps({'kind': k, 'shape': list(o.shape), 'rows': R, 'columns': C, 'dtypes': dt,
                           'headers': h, 'index': idx, 'cells': cells})
    except Exception as e:
        return json.dumps({'error': '%s: %s' % (type(e).__name__, e)})
`;

/**
 * The window moved back onto the object when a step or another frame left it with fewer rows
 * or columns than the window starts at (the last page then); `w` itself when it still fits.
 */
export function clampWindow(w: TableWindow, page: Pick<TablePage, "rows" | "columns">): TableWindow {
  const fit = (at: number, total: number, size: number) =>
    at < total ? at : Math.max(0, Math.floor((total - 1) / size) * size);
  const row = fit(w.row, page.rows, ROW_PAGE);
  const column = fit(w.column, page.columns, COLUMN_PAGE);
  return row === w.row && column === w.column ? w : { row, column };
}

/**
 * One expression (evaluate takes no statements): defines the helper in a fresh namespace
 * and calls it. `expression` is passed as an argument, outside the lambda, because a
 * lambda body can't see the frame's locals that `eval` was given.
 */
export function tableExpression(expression: string, w: TableWindow): string {
  return (
    `(lambda g, o: (exec(${JSON.stringify(HELPER)}, g), ` +
    `g['f'](o, ${w.row}, ${ROW_PAGE}, ${w.column}, ${COLUMN_PAGE}))[1])({}, (${expression}))`
  );
}

/** The helper's reply (a Python string literal holding JSON), or the adapter's own error text. */
export function parseTableResult(value: string): TableResult {
  let data: unknown;
  try {
    data = JSON.parse(stringText(value));
  } catch {
    return { error: value };
  }
  const d = data as Record<string, unknown>;
  if (typeof d.error === "string")
    return d.error === "ndim" ? { error: "ndim", ndim: Number(d.ndim) } : { error: d.error };
  return { page: d as unknown as TablePage };
}
