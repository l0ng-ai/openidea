import clsx from "clsx";
import { List, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { call, commands, type HeapClassRow, type HeapObjectRow } from "@/platform/ipc";
import { formatBytes } from "../../memory/rows";
import { useHeapQuery } from "./heapQuery";
import { ObjectText } from "./ObjectText";
import styles from "../HeapSnapshotEditor.module.css";

const LIMIT = 100;

/** The objects of one class that keep the most memory alive, biggest first. */
export function BiggestObjects({
  snapshot,
  cls,
  selected,
  onSelect,
}: {
  snapshot: number;
  cls: HeapClassRow;
  selected: number | null;
  onSelect: (object: HeapObjectRow) => void;
}) {
  const page = useHeapQuery(`${snapshot}:${cls.classIndex}`, () =>
    call(commands.debugHeapDominators(snapshot, null, cls.classIndex, 0, LIMIT)),
  );
  const { name } = cls;
  const title = tx`Biggest objects of ${name}`;
  const rows = page.data?.rows ?? [];
  return (
    <section className={styles.pane} aria-label={title}>
      <div className={styles.paneTitle}>{title}</div>
      {page.error && (
        <div className={styles.error} role="alert">
          {page.error}
        </div>
      )}
      {page.data && (
        <div className={clsx(styles.table, styles.objectColumns)} role="table" aria-label={title}>
          <div role="rowgroup">
            <div className={styles.head} role="row" aria-rowindex={1}>
              <div role="columnheader" className={styles.headCell}>
                <T>Object</T>
              </div>
              <div role="columnheader" className={clsx(styles.headCell, styles.numeric)}>
                <T>Shallow Size</T>
              </div>
              <div role="columnheader" className={clsx(styles.headCell, styles.numeric)}>
                <T>Retained Size</T>
              </div>
            </div>
          </div>
          <List
            className={styles.list}
            items={rows}
            getKey={(o) => String(o.object)}
            renderItem={(o) => (
              <div className={styles.row} role="none">
                <span role="cell" className={styles.cell}>
                  <ObjectText object={o} />
                </span>
                <span role="cell" className={clsx(styles.cell, styles.num)}>
                  {formatBytes(o.shallow)}
                </span>
                <span role="cell" className={clsx(styles.cell, styles.num)}>
                  {formatBytes(o.retained)}
                </span>
              </div>
            )}
            activeIndex={selected === null ? -1 : rows.findIndex((o) => o.object === selected)}
            onActiveChange={(i) => rows[i] && onSelect(rows[i])}
            rowHeight={22}
            tableBody={{ headerRows: 1 }}
          />
        </div>
      )}
    </section>
  );
}
