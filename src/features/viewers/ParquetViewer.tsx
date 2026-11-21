import { useEffect, useRef, useState } from "react";
import type { ParquetPage } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, Dialog, IconButton, T } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { formatSize } from "./fileKinds";
import { useForwardFocus } from "./forwardFocus";
import styles from "./ParquetViewer.module.css";

export function ParquetViewer({ input }: { input: EditorInput }) {
  const path = input.path!;
  const scroll = useRef<HTMLDivElement>(null);
  useForwardFocus(scroll);
  const [offset, setOffset] = useState(0);
  const [schema, setSchema] = useState(false);
  const [cell, setCell] = useState<{ name: string; value: string } | null>(null);
  const [result, setResult] = useState<
    { path: string; offset: number } & ({ page: ParquetPage } | { error: string })
  >();
  const current = result?.path === path && result.offset === offset ? result : undefined;
  const page = current && "page" in current ? current.page : undefined;
  const error = current && "error" in current ? current.error : undefined;
  const count = page?.totalRows.toLocaleString();
  const groups = page?.rowGroups.toLocaleString();
  const name = cell?.name;

  useEffect(() => {
    let live = true;
    call(commands.fsReadParquet(path, offset)).then(
      (page) => {
        if (live) setResult({ path, offset, page });
      },
      (error: unknown) => {
        if (live) setResult({ path, offset, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [path, offset]);

  const go = (next: number) => {
    scroll.current?.scrollTo({ top: 0 });
    setOffset(next);
  };

  return (
    <div className={styles.viewer}>
      {page && (
        <div className={styles.toolbar} role="toolbar" aria-label={tx("Parquet preview")}>
          <Button size="small" variant="ghost" aria-pressed={!schema} onClick={() => setSchema(false)}>
            Rows
          </Button>
          <Button size="small" variant="ghost" aria-pressed={schema} onClick={() => setSchema(true)}>
            Schema
          </Button>
          <span className={styles.metadata}>
            {tx`${count} rows`} · {tx`${groups} row groups`} · {formatSize(page.size)}
            {page.compression.length > 0 && ` · ${page.compression.join(", ")}`}
          </span>
          {!schema && (
            <div className={styles.pager}>
              <IconButton
                size="small"
                icon="chevron-left"
                title="Previous page"
                disabled={offset === 0}
                onClick={() => go(Math.max(0, offset - page.pageSize))}
              />
              <span aria-live="polite">
                {page.rows.length > 0
                  ? `${(offset + 1).toLocaleString()}–${(offset + page.rows.length).toLocaleString()}`
                  : "0"}
              </span>
              <IconButton
                size="small"
                icon="chevron-right"
                title="Next page"
                disabled={!page.rows.length || offset + page.rows.length >= page.totalRows}
                onClick={() => go(offset + page.rows.length)}
              />
            </div>
          )}
        </div>
      )}
      <div className={styles.scroll} ref={scroll} tabIndex={0} aria-busy={!current}>
        {error !== undefined ? (
          <div className={styles.message} role="alert">
            <T>Could not read Parquet file</T>
            <div>{error}</div>
            {offset > 0 && (
              <Button size="small" onClick={() => go(0)}>
                First page
              </Button>
            )}
          </div>
        ) : !page ? (
          <div className={styles.message} role="status">
            <T>Loading…</T>
          </div>
        ) : schema ? (
          <table className={styles.table} aria-label={tx("Schema")}>
            <thead>
              <tr>
                <th>
                  <T>Column</T>
                </th>
                <th>
                  <T>Type</T>
                </th>
                <th>
                  <T>Nullable</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.columns.map((column, index) => (
                <tr key={index}>
                  <td>{column.name}</td>
                  <td>
                    <code>{column.dataType}</code>
                  </td>
                  <td>{column.nullable ? tx("Yes") : tx("No")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            <table className={styles.table} aria-label={tx("Parquet rows")}>
              <thead>
                <tr>
                  <th scope="col" aria-label={tx("Row")} />
                  {page.columns.map((column, index) => (
                    <th key={index} scope="col">
                      {column.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, index) => (
                  <tr key={offset + index}>
                    <th scope="row">{(offset + index + 1).toLocaleString()}</th>
                    {row.map((value, column) => (
                      <td key={column}>
                        {value === null ? (
                          <span className={styles.null}>NULL</span>
                        ) : (
                          <button
                            className={styles.cell}
                            type="button"
                            onClick={() => setCell({ name: page.columns[column]!.name, value })}
                          >
                            {value}
                          </button>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!page.rows.length && (
              <div className={styles.message}>
                <T>No rows</T>
              </div>
            )}
          </>
        )}
      </div>
      {cell && (
        <Dialog
          open
          title={tx`Value in ${name}`}
          onClose={() => setCell(null)}
          buttons={[{ label: "Close", role: "default", onClick: () => setCell(null) }]}
        >
          <pre className={styles.cellValue}>{cell.value}</pre>
        </Dialog>
      )}
    </div>
  );
}
