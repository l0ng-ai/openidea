/** Instances of one class under the Memory table: each opens into its fields and the objects that refer to it. */
import { useCallback, useEffect, useMemo } from "react";
import { Button, IconButton, Spinner, T, Tree } from "@/ui";
import { tx } from "@/platform/i18n";
import type { DebugSessionId, JvmValue } from "@/platform/ipc";
import type { DebugSession } from "../state";
import {
  ensureFields,
  instancesOutdated,
  loadFields,
  loadReferrers,
  setInstancesExpanded,
  setInstancesLead,
  showInstances,
  showReferrers,
  useInstances,
  type NodeEntry,
} from "./instancesState";
import {
  childrenOf,
  inspectUnavailableText,
  instanceNodes,
  labelOf,
  outdatedText,
  type PaneNode,
  type Retry,
} from "./instancesTree";
import { keepKeysOnButton } from "./rowButtonKeys";
import { formatCount } from "./rows";
import styles from "./InstancesPane.module.css";

export function InstancesPane({ session }: { session: DebugSession }) {
  const id = session.id;
  const entry = useInstances((s) => s.bySession[id]);
  if (!entry) return null;
  const name = entry.className;
  const title = tx`Instances of ${name}`;
  const result = entry.result;
  const outdated = instancesOutdated(entry, session.stops);
  return (
    <section className={styles.pane} aria-label={title}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <IconButton
          icon="edit-source"
          action="debug.memory.jumpToSource"
          actionArg={name}
          title="Jump to Source"
          size="small"
        />
        <IconButton
          icon="close"
          action="debug.memory.closeInstances"
          actionArg={id}
          title="Close Instances"
          size="small"
        />
      </div>
      {entry.loading && (
        <div className={styles.note} role="status">
          <Spinner size={12} /> <T>Loading…</T>
        </div>
      )}
      {entry.error && (
        <div className={styles.error} role="alert">
          {entry.error}
        </div>
      )}
      {result?.status === "unavailable" && (
        <div className={styles.note}>
          {inspectUnavailableText(result.reason)}
          {result.reason.kind === "timedOut" && (
            <Button size="small" className={styles.retry} onClick={() => void showInstances(id, name)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {result?.status === "ready" && (
        <>
          {outdated && (
            <div className={styles.banner} role="status">
              {outdatedText()}
              <IconButton
                icon="refresh"
                action="debug.memory.showInstances"
                actionArg={name}
                title="Show Instances"
                size="small"
                disabled={session.status !== "paused"}
              />
            </div>
          )}
          {result.truncated && <Truncated count={result.instances.length} />}
          <InstanceTree
            key={`${name}:${result.generation}`}
            id={id}
            label={title}
            instances={result.instances}
            generation={result.generation}
            nodes={entry.nodes}
            expandedKeys={entry.expanded}
            outdated={outdated}
            paused={session.status === "paused"}
          />
        </>
      )}
    </section>
  );
}

function Truncated({ count }: { count: number }) {
  const n = formatCount(count);
  return <div className={styles.note}>{tx`Showing the first ${n} instances.`}</div>;
}

function InstanceTree({
  id,
  label,
  instances,
  generation,
  nodes,
  expandedKeys,
  outdated,
  paused,
}: {
  id: DebugSessionId;
  label: string;
  instances: JvmValue[];
  generation: number;
  nodes: Record<string, NodeEntry>;
  expandedKeys: string[];
  outdated: boolean;
  /** Referrers are read only while the program is paused, like the Show Referrers action. */
  paused: boolean;
}) {
  const expanded = useMemo(() => new Set(expandedKeys), [expandedKeys]);
  const roots = useMemo(() => instanceNodes(generation, instances), [generation, instances]);
  // The lead row only means something while this tree shows it.
  useEffect(() => () => setInstancesLead(id, null), [id]);
  const getChildren = useCallback((n: PaneNode) => childrenOf(n, nodes), [nodes]);
  // Objects of an earlier stop cannot be read any more; what was already loaded stays open.
  const isExpandable = useCallback(
    (n: PaneNode) =>
      n.kind === "referrers" || (n.kind === "value" && !!n.ref && (!outdated || childrenOf(n, nodes) !== undefined)),
    [nodes, outdated],
  );

  const onReferrers = (n: PaneNode) => {
    if (n.kind === "value" && n.ref) showReferrers(id, n.key, n.ref);
  };

  const retry = ({ what, ref }: Retry) => void (what === "fields" ? loadFields(id, ref) : loadReferrers(id, ref));

  return (
    <Tree<PaneNode>
      className={styles.tree}
      aria-label={label}
      roots={roots}
      getKey={(n) => n.key}
      getLabel={labelOf}
      getChildren={getChildren}
      isExpandable={isExpandable}
      expanded={expanded}
      onExpandedChange={(next, n, open) => {
        setInstancesExpanded(id, next);
        if (open && n.kind === "value" && n.ref) ensureFields(id, n.ref);
      }}
      onSelectionChange={(_selected, lead) =>
        setInstancesLead(id, lead?.kind === "value" && lead.ref ? { key: lead.key, ref: lead.ref } : null)
      }
      rowClassName={() => styles.row}
      renderNode={(n) => (
        <NodeRow node={n} referrersDisabled={outdated || !paused} onReferrers={onReferrers} onRetry={retry} />
      )}
      empty={
        <span className={styles.note}>
          <T>Nothing to show</T>
        </span>
      }
    />
  );
}

function NodeRow({
  node,
  referrersDisabled,
  onReferrers,
  onRetry,
}: {
  node: PaneNode;
  referrersDisabled: boolean;
  onReferrers: (n: PaneNode) => void;
  onRetry: (r: Retry) => void;
}) {
  switch (node.kind) {
    case "value":
      return (
        <span className={styles.node}>
          {node.name != null && (
            <>
              <span className={styles.name}>{node.name}</span>
              <span className={styles.equals}> = </span>
            </>
          )}
          <span className={styles.value}>{labelOf(node)}</span>
          {node.ref && (
            <IconButton
              icon="hierarchy"
              title="Show Referrers"
              size="small"
              className={styles.rowButton}
              disabled={referrersDisabled}
              onKeyDown={keepKeysOnButton}
              onClick={() => onReferrers(node)}
            />
          )}
        </span>
      );
    case "referrers":
      return (
        <span className={styles.group}>
          <T>Referrers</T>
        </span>
      );
    case "message":
      return (
        <span className={styles.message}>
          {node.text}
          {node.retry && (
            <Button
              size="small"
              variant="ghost"
              className={styles.retry}
              onKeyDown={keepKeysOnButton}
              onClick={() => onRetry(node.retry!)}
            >
              Retry
            </Button>
          )}
        </span>
      );
  }
}
