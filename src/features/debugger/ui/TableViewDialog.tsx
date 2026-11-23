/** View as Table: a DataFrame / Series / ndarray of the paused frame, one page of rows and columns at a time. */
import { useEffect, useRef, useState } from "react";
import type { DebugSessionId } from "@/platform/ipc";
import { Dialog, IconButton, Input } from "@/ui";
import { formatMessage, tx } from "@/platform/i18n";
import { evaluate, useDebug } from "../state";
import { COLUMN_PAGE, ROW_PAGE, clampWindow, parseTableResult, tableExpression, type TableResult } from "../tableView";
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

  // What the shown page was read for; another expression, stop or frame makes it stale.
  const readFor = useRef("");

  useEffect(() => {
    const key = `${expression}\n${stops}\n${frame}`;
    if (readFor.current !== key) {
      readFor.current = key;
      setResult(null);
    }
    const s = useDebug.getState().sessions[session];
    // Right after a stop the frame is unknown until the stack trace arrives; without a frame,
    // debugpy would run the expression in a namespace of its own.
    if (!s || s.status !== "paused" || s.selectedFrame == null) return;
    let live = true;
    evaluate(tableExpression(expression, win), "clipboard", s).then(
      (v) => {
        if (!live) return;
        const r = parseTableResult(v.value);
        const fits = "page" in r ? clampWindow(win, r.page) : win;
        if (fits !== win) setWin(fits);
        else setResult(r);
      },
      (e: unknown) => live && setResult({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [expression, win, session, stops, frame, paused]);

  const page = paused && result && "page" in result ? result.page : null;
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
      title={<span>{expression}</span>}
      width={700}
      minWidth={420}
      minHeight={260}
      resizable="both"
      aria-label={formatMessage(tx("Table view of {label}"), { label: expression })}
      buttons={[{ label: "Close", role: "cancel" }]}
      className={styles.dialog}
    >
      <div className={styles.content}>
        {page && (
          <div className={styles.bar}>
            <span className={styles.summary}>
              {formatMessage(tx("Shape ({shape})"), { shape: page.shape.join(", ") })}
              {page.kind !== "frame" ? ` · ${page.dtypes[0]}` : ""}
            </span>
            <div className={styles.pagers}>
              {pager(win.row, ROW_PAGE, page.rows, (row) => setWin({ ...win, row }), {
                range: tx("Rows {from}–{to} of {total}"),
                previous: tx("Previous Rows"),
                next: tx("Next Rows"),
              })}
              {pager(win.column, COLUMN_PAGE, page.columns, (column) => setWin({ ...win, column }), {
                range: tx("Columns {from}–{to} of {total}"),
                previous: tx("Previous Columns"),
                next: tx("Next Columns"),
              })}
            </div>
          </div>
        )}
        {page ? (
          <div className={styles.scroll} tabIndex={0} role="region" aria-label={tx("Table")}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.index} />
                  {page.headers.map((h, i) => (
                    <th key={i}>
                      {h}
                      {page.kind === "frame" && <span className={styles.dtype}>{page.dtypes[i]}</span>}
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
                      <td key={c}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.message}>{!error && tx("Loading…")}</div>
        )}
        <Input
          className={styles.expression}
          mono
          data-autofocus=""
          value={draft}
          aria-label="Expression"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !draft.trim()) return;
            e.preventDefault();
            setExpression(draft.trim());
            setWin({ row: 0, column: 0 });
          }}
        />
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
