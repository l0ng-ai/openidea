/** The shortest chain of references that keeps the selected object alive, from the object up to its GC root. */
import { List, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { call, commands, type HeapObjectRow } from "@/platform/ipc";
import { edgeText } from "./edgeText";
import { useHeapQuery } from "./editor/heapQuery";
import { ObjectText } from "./editor/ObjectText";
import styles from "./HeapSnapshotEditor.module.css";

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
          items={path.data}
          getKey={(step, i) => `${i}:${step.object.object}`}
          renderItem={(step) => (
            <div className={styles.step}>
              <ObjectText object={step.object} />
              <span className={styles.edge}>{edgeText(step.via)}</span>
            </div>
          )}
          rowHeight={22}
        />
      )}
    </section>
  );
}
