/**
 * The Dominators view of a heap snapshot: the objects that keep the most memory alive, each opening to the objects only
 * it keeps alive. Children arrive a page at a time.
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Button, Spinner, T, Tree } from "@/ui";
import { tx } from "@/platform/i18n";
import { call, commands, type HeapObjectRow } from "@/platform/ipc";
import { formatBytes } from "../memory/rows";
import { retainedShare } from "./editor/classRows";
import { heapErrorText } from "./editor/heapQuery";
import { ObjectText } from "./editor/ObjectText";
import {
  childNodes,
  nodeKey,
  PAGE,
  ROOT,
  withError,
  withPage,
  type DominatorNode,
  type DominatorPages,
} from "./editor/dominatorPages";
import styles from "./HeapSnapshotEditor.module.css";

const labelOf = (n: DominatorNode): string =>
  n.kind === "object" ? `${n.row.className}@${n.row.address}` : n.kind === "more" ? tx("Show more") : n.text;

export function HeapDominators({
  snapshot,
  reachableBytes,
  onSelect,
}: {
  snapshot: number;
  reachableBytes: number;
  onSelect: (object: HeapObjectRow) => void;
}) {
  const [pages, setPages] = useState<DominatorPages>({});

  const load = useCallback(
    (key: string, parent: number | null, offset: number): Promise<void> =>
      call(commands.debugHeapDominators(snapshot, parent, null, offset, PAGE)).then(
        (answer) => setPages((p) => withPage(p, key, parent, offset, answer)),
        (e: unknown) => setPages((p) => withError(p, key, parent, heapErrorText(e))),
      ),
    [snapshot],
  );

  useEffect(() => void load(ROOT, null, 0), [load]);

  const showMore = (parentKey: string) => {
    const page = pages[parentKey];
    if (!page || page.loadingMore) return;
    setPages((p) => ({ ...p, [parentKey]: { ...page, loadingMore: true } }));
    void load(parentKey, page.parent, page.rows.length);
  };

  const getChildren = useCallback(
    (n: DominatorNode) => (n.kind === "object" ? childNodes(pages, n.key) : undefined),
    [pages],
  );
  const roots = childNodes(pages, ROOT);

  return (
    <div className={clsx(styles.view, styles.dominatorColumns)}>
      <div className={clsx(styles.head, styles.treeHead)} role="presentation">
        <span className={styles.headCell}>
          <T>Object</T>
        </span>
        <span className={clsx(styles.headCell, styles.numeric)}>
          <T>Shallow Size</T>
        </span>
        <span className={clsx(styles.headCell, styles.numeric)}>
          <T>Retained Size</T>
        </span>
        <span className={clsx(styles.headCell, styles.numeric)}>%</span>
      </div>
      {roots === undefined ? (
        <div className={styles.note}>
          <Spinner size={12} /> <T>Loading…</T>
        </div>
      ) : (
        <Tree<DominatorNode>
          className={styles.list}
          aria-label={tx("Dominators")}
          roots={roots}
          getKey={(n) => n.key}
          getLabel={labelOf}
          getChildren={getChildren}
          isExpandable={(n) => n.kind === "object" && n.row.hasChildren}
          loadChildren={(n) => (n.kind === "object" ? load(nodeKey(n.row), n.row.object, 0) : undefined)}
          onSelectionChange={(_selected, lead) => {
            if (lead?.kind === "object") onSelect(lead.row);
          }}
          onActivate={(n) => {
            if (n.kind === "more") showMore(n.parent);
          }}
          renderNode={(n) => {
            if (n.kind === "more") {
              return (
                <Button
                  size="small"
                  variant="ghost"
                  disabled={pages[n.parent]?.loadingMore}
                  onClick={() => showMore(n.parent)}
                >
                  Show more
                </Button>
              );
            }
            if (n.kind === "error") return <span className={styles.errorText}>{n.text}</span>;
            return (
              <span className={styles.treeRow}>
                <span className={styles.cell}>
                  <ObjectText object={n.row} />
                </span>
                <span className={clsx(styles.cell, styles.num)}>{formatBytes(n.row.shallow)}</span>
                <span className={clsx(styles.cell, styles.num)}>{formatBytes(n.row.retained)}</span>
                <span className={clsx(styles.cell, styles.num)}>{retainedShare(n.row.retained, reachableBytes)}</span>
              </span>
            );
          }}
          empty={
            <span className={styles.note}>
              <T>Nothing to show</T>
            </span>
          }
        />
      )}
    </div>
  );
}
