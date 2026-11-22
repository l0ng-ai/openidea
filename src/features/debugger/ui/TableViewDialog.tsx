/** View as Table: a DataFrame / Series / ndarray of the paused frame, one page of rows and columns at a time. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { DebugSessionId } from "@/platform/ipc";
import { Dialog, IconButton } from "@/ui";
import { formatMessage, tx } from "@/platform/i18n";
import { evaluate, useDebug } from "../state";
import {
  COLUMN_PAGE,
  ROW_PAGE,
  isNumericDtype,
  parseTableResult,
  tableExpression,
  type TableResult,
} from "../tableView";
import styles from "./TableViewDialog.module.css";

export function TableViewDialog({
  expression: initial,
  session,
  onClose,
}: {
  expression: string;
  session: DebugSessionId;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [expression, setExpression] = useState(initial);
  const [win, setWin] = useState({ row: 0, column: 0 });
  const [result, setResult] = useState<TableResult | null>(null);
  // A step, a new stop or another frame shows the values the object has there.
  const stops = useDebug((st) => st.sessions[session]?.stops);
  const frame = useDebug((st) => st.sessions[session]?.selectedFrame);
  const paused = useDebug((st) => st.sessions[session]?.status === "paused");

  useEffect(() => {
    const s = useDebug.getState().sessions[session];
    if (!s || s.status !== "paused") return;
    let live = true;
    evaluate(tableExpression(expression, win), "clipboard", s).then(
      (v) => live && setResult(parseTableResult(v.value)),
      // A traceback ends with the exception line, the part worth showing ("NameError: name 'df' is not defined").
      (e: unknown) =>
        live && setResult({ error: (e instanceof Error ? e.message : String(e)).trim().split("\n").pop()! }),
    );
    return () => {
      live = false;
    };
  }, [expression, win, session, stops, frame, paused]);

  const page = result && "page" in result ? result.page : null;
  const error = !paused
    ? tx("Values are available while the program is paused")
    : result && "error" in result
      ? result.error === "type"
        ? tx("Not a pandas DataFrame or Series, or a numpy array")
        : result.error === "ndim"
          ? formatMessage(tx("A {n}-dimensional array can't be shown as a table: view a 2-D slice, e.g. a[0]"), {
              n: String(result.ndim),
            })
          : result.error
      : null;

  const pager = (
    at: number,
    size: number,
    total: number,
    move: (to: number) => void,
    label: { range: string; previous: string; next: string },
  ) =>
    total > size && (
      <span className={styles.pager}>
        <IconButton
          icon="chevron-left"
          size="small"
          title={label.previous}
          disabled={at === 0}
          onClick={() => move(at - size)}
        />
        <span>
          {formatMessage(label.range, {
            from: String(at + 1),
            to: String(Math.min(at + size, total)),
            total: String(total),
          })}
        </span>
        <IconButton
          icon="chevron-right"
          size="small"
          title={label.next}
          disabled={at + size >= total}
          onClick={() => move(at + size)}
        />
      </span>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      // An element, not a string: Dialog would translate a variable named like a catalog text ("tasks").
      title={<span>{initial}</span>}
      width="clamp(520px, 70vw, 1100px)"
      minWidth={420}
      minHeight={260}
      resizable="both"
      aria-label={formatMessage(tx("Table view of {label}"), { label: initial })}
      className={styles.dialog}
    >
      <div className={styles.content}>
        <div className={styles.bar}>
          <input
            className={styles.expression}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            aria-label={tx("Expression")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !draft.trim()) return;
              e.preventDefault();
              setExpression(draft.trim());
              setWin({ row: 0, column: 0 });
            }}
          />
          {page && (
            <span className={styles.summary}>
              {formatMessage(tx("Shape ({shape})"), { shape: page.shape.join(", ") })}
              {page.dtypes.length === 1 ? ` · ${page.dtypes[0]}` : ""}
            </span>
          )}
          {page &&
            pager(win.row, ROW_PAGE, page.rows, (row) => setWin({ ...win, row }), {
              range: tx("Rows {from}–{to} of {total}"),
              previous: tx("Previous Rows"),
              next: tx("Next Rows"),
            })}
          {page &&
            pager(win.column, COLUMN_PAGE, page.columns, (column) => setWin({ ...win, column }), {
              range: tx("Columns {from}–{to} of {total}"),
              previous: tx("Previous Columns"),
              next: tx("Next Columns"),
            })}
        </div>
        {error ? (
          <div className={styles.message} role="alert">
            {error}
          </div>
        ) : page ? (
          <div className={styles.scroll} tabIndex={0} role="region" aria-label={tx("Table")}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.index} />
                  {page.headers.map((h, i) => (
                    <th key={i} title={page.dtypes.length > 1 ? page.dtypes[i] : undefined}>
                      {h}
                      {page.dtypes.length > 1 && <span className={styles.dtype}>{page.dtypes[i]}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.cells.map((row, r) => (
                  <tr key={r}>
                    <th scope="row" className={styles.index}>
                      {page.index[r]}
                    </th>
                    {row.map((cell, c) => (
                      <td key={c} className={clsx(isNumericDtype(page.dtypes[c] ?? page.dtypes[0]) && styles.numeric)}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.message}>{tx("Loading…")}</div>
        )}
      </div>
    </Dialog>
  );
}
