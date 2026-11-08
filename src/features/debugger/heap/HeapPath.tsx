/** The shortest chain of references that keeps the selected object alive, from the object up to its GC root. */
import { List, T } from "@/ui";
import { formatMessage, tx } from "@/platform/i18n";
import { call, commands, type HeapObjectRow, type HeapPathStep, type HeapRootPath } from "@/platform/ipc";
import { formatCount } from "../memory/rows";
import { edgeText } from "./edgeText";
import { useHeapQuery } from "./editor/heapQuery";
import { ObjectText } from "./editor/ObjectText";
import styles from "./HeapSnapshotEditor.module.css";

type PathRow = { step: HeapPathStep } | { omitted: number };

/** The steps, with a row for the ones a long path leaves out where they would be. */
function pathRows(path: HeapRootPath): PathRow[] {
  const rows: PathRow[] = path.steps.map((step) => ({ step }));
  if (path.omitted > 0) rows.splice(path.omittedAfter, 0, { omitted: path.omitted });
  return rows;
}

export function HeapPath({ snapshot, object }: { snapshot: number; object: HeapObjectRow }) {
  const path = useHeapQuery(`${snapshot}:${object.object}`, () =>
    call(commands.debugHeapPath(snapshot, object.object)),
  );
  return (
    <section className={styles.pane} aria-label={tx("Path to GC Root")}>
      <div className={styles.paneTitle}>
        <T>Path to GC Root</T>
      </div>
      {path.error && (
        <div className={styles.error} role="alert">
          {path.error}
        </div>
      )}
      {path.data === null && (
        <div className={styles.note}>
          <T>This object is not reachable from a GC root.</T>
        </div>
      )}
      {path.data && (
        <List
          className={styles.list}
          aria-label={tx("Path to GC Root")}
          items={pathRows(path.data)}
          getKey={(row, i) => ("step" in row ? `${i}:${row.step.object.object}` : `${i}:omitted`)}
          renderItem={(row) =>
            "step" in row ? (
              <div className={styles.step}>
                <ObjectText object={row.step.object} />
                <span className={styles.edge}>{edgeText(row.step.via)}</span>
              </div>
            ) : (
              <div className={styles.omitted}>
                {formatMessage(tx("Path truncated: {count} steps not shown"), { count: formatCount(row.omitted) })}
              </div>
            )
          }
          rowHeight={22}
        />
      )}
    </section>
  );
}
