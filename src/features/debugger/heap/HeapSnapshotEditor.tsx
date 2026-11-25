/** The "Heap" editor tab: one heap snapshot's classes, dominator tree and paths to GC roots, compared with another. */
import { useMemo, useState } from "react";
import { Tabs, T } from "@/ui";
import { call, commands, type HeapClassRow, type HeapObjectRow } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";
import { changesByName } from "./editor/classRows";
import { BiggestObjects } from "./editor/BiggestObjects";
import { HeapHeader } from "./editor/HeapHeader";
import { useHeapQuery } from "./editor/heapQuery";
import { HeapClasses } from "./HeapClasses";
import { HeapDominators } from "./HeapDominators";
import { HeapPath } from "./HeapPath";
import { heapSnapshotOf } from "./heapInput";
import { useHeap, type HeapSnapshotEntry } from "./heapState";
import styles from "./HeapSnapshotEditor.module.css";

type View = "classes" | "dominators";

const VIEWS = [
  { id: "classes", label: "Classes" },
  { id: "dominators", label: "Dominators" },
];

export function HeapSnapshotEditor({ input }: { input: EditorInput }) {
  const id = heapSnapshotOf(input);
  const entry = useHeap((s) => (id === null ? undefined : s.snapshots[id]));
  // Snapshots belong to the window that opened them; a tab moved or restored into another window finds none here.
  if (!entry) {
    return (
      <div className={styles.root}>
        <div className={styles.note} role="status">
          <T>This heap snapshot is not available in this window.</T>
        </div>
      </div>
    );
  }
  return <SnapshotView key={entry.info.id} entry={entry} />;
}

function SnapshotView({ entry }: { entry: HeapSnapshotEntry }) {
  const { info } = entry;
  const id = info.id;
  const [view, setView] = useState<View>("classes");
  // The tree is read from the host only once the view is first opened.
  const [dominatorsShown, setDominatorsShown] = useState(false);
  const [selectedClass, setSelectedClass] = useState<HeapClassRow | null>(null);
  const [selectedObject, setSelectedObject] = useState<HeapObjectRow | null>(null);
  const [compareWith, setCompareWith] = useState<number | null>(null);
  // The compared snapshot may close while this tab stays open.
  const base = useHeap((s) => (compareWith !== null && compareWith in s.snapshots ? compareWith : null));

  // The capture or open already read the table; it is read again only when that failed.
  const reread = useHeapQuery(entry.classes ? null : `classes:${id}`, () => call(commands.debugHeapClasses(id)));
  const classes = entry.classes ?? reread.data ?? null;
  const diff = useHeapQuery(base === null ? null : `compare:${base}:${id}`, () =>
    call(commands.debugHeapCompare(base!, id)),
  );
  const changes = useMemo(() => (diff.data ? changesByName(diff.data) : null), [diff.data]);

  const selectClass = (row: HeapClassRow | null) => {
    setSelectedClass(row);
    setSelectedObject(null);
  };

  return (
    <div className={styles.root}>
      <HeapHeader info={info} compareWith={base} onCompare={setCompareWith} />
      <Tabs
        variant="compact"
        items={VIEWS}
        activeId={view}
        onSelect={(v) => {
          setView(v as View);
          if (v === "dominators") setDominatorsShown(true);
        }}
        aria-label={info.label}
        className={styles.views}
      />
      {(reread.error ?? diff.error) && (
        <div className={styles.error} role="alert">
          {reread.error ?? diff.error}
        </div>
      )}
      <div className={styles.body}>
        {/* Both views stay mounted once shown, so switching back keeps the filter, sort and expanded nodes. */}
        <div className={styles.main} hidden={view !== "classes"}>
          {classes && (
            <HeapClasses
              classes={classes}
              changes={base === null ? null : changes}
              selected={selectedClass?.classIndex ?? null}
              onSelect={selectClass}
            />
          )}
        </div>
        {dominatorsShown && (
          <div className={styles.main} hidden={view !== "dominators"}>
            <HeapDominators snapshot={id} reachableBytes={info.summary.reachableBytes} onSelect={setSelectedObject} />
          </div>
        )}
        {((view === "classes" && selectedClass) || selectedObject) && (
          <div className={styles.details}>
            {view === "classes" && selectedClass && (
              <BiggestObjects
                snapshot={id}
                cls={selectedClass}
                selected={selectedObject?.object ?? null}
                onSelect={setSelectedObject}
              />
            )}
            {selectedObject && <HeapPath snapshot={id} object={selectedObject} />}
          </div>
        )}
      </div>
    </div>
  );
}
