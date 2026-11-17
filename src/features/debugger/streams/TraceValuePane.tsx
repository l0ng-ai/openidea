/** The selected value of a trace, opened into its fields like an instance in the Memory view. */
import { useCallback, useMemo, useRef, useState } from "react";
import { T, Tree } from "@/ui";
import { useTx } from "@/platform/i18n";
import { call, commands, type DebugSessionId, type JvmObjectRef, type JvmValue } from "@/platform/ipc";
import type { NodeEntry } from "../memory/instancesState";
import { childrenOf, instanceNodes, labelOf, type PaneNode } from "../memory/instancesTree";
import { refKey } from "../memory/values";
import styles from "./StreamTraceEditor.module.css";

const NOTHING_LOADED: NodeEntry = {
  fields: null,
  referrers: null,
  loadingFields: false,
  loadingReferrers: false,
  error: null,
};

/** Fields read so far for one trace, kept while the user moves between its values. */
export function useTraceFields(session: DebugSessionId) {
  const [nodes, setNodes] = useState<Record<string, NodeEntry>>({});
  const asked = useRef(new Set<string>());
  const ensure = useCallback(
    (ref: JvmObjectRef) => {
      const key = refKey(ref);
      if (asked.current.has(key)) return;
      asked.current.add(key);
      const put = (n: Partial<NodeEntry>) => setNodes((p) => ({ ...p, [key]: { ...NOTHING_LOADED, ...n } }));
      put({ loadingFields: true });
      call(commands.debugJvmMemoryFields(session, ref)).then(
        (fields) => put({ fields }),
        (e: unknown) => {
          // Opening it again asks again.
          asked.current.delete(key);
          put({ error: e instanceof Error ? e.message : String(e) });
        },
      );
    },
    [session],
  );
  return { nodes, ensure };
}

export function TraceValuePane({
  value,
  generation,
  outdated,
  fields,
}: {
  value: JvmValue;
  generation: number;
  /** The program ran on: what was read stays open, nothing more is read. */
  outdated: boolean;
  fields: ReturnType<typeof useTraceFields>;
}) {
  const tx = useTx();
  const { nodes, ensure } = fields;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const roots = useMemo(() => instanceNodes(generation, [value]), [generation, value]);
  const getChildren = useCallback((n: PaneNode) => childrenOf(n, nodes, tx), [nodes, tx]);
  const getLabel = useCallback((n: PaneNode) => labelOf(n, tx), [tx]);
  const isExpandable = useCallback(
    (n: PaneNode) => n.kind === "value" && !!n.ref && (!outdated || childrenOf(n, nodes) !== undefined),
    [nodes, outdated],
  );
  return (
    <section className={styles.valuePane} aria-label={tx("Value")}>
      <Tree<PaneNode>
        className={styles.valueTree}
        aria-label={tx("Value")}
        roots={roots}
        getKey={(n) => n.key}
        getLabel={getLabel}
        getChildren={getChildren}
        isExpandable={isExpandable}
        expanded={expanded}
        onExpandedChange={(next, n, open) => {
          setExpanded(next);
          if (open && !outdated && n.kind === "value" && n.ref) ensure(n.ref);
        }}
        renderNode={(n) => <ValueRow node={n} label={getLabel(n)} />}
        empty={
          <span className={styles.note}>
            <T>Nothing to show</T>
          </span>
        }
      />
    </section>
  );
}

function ValueRow({ node, label }: { node: PaneNode; label: string }) {
  if (node.kind !== "value") return <span className={styles.message}>{label}</span>;
  return (
    <span className={styles.node}>
      {node.name != null && (
        <>
          <span className={styles.name}>{node.name}</span>
          <span className={styles.equals}> = </span>
        </>
      )}
      <span className={styles.value}>{label}</span>
    </span>
  );
}
