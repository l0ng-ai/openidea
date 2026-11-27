/** The sbt tool window: each build's projects with their tasks and the build's sbt run configurations. */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import type { RunConfig, SbtBuild } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  Spinner,
  T,
  Tree,
  showContextMenu,
  type MenuItem,
  type TreeRowState,
} from "@/ui";
import { sbtChildren, sbtIcon, sbtLabel, sbtNodeConfig, sbtRoots, type SbtNode } from "./sbt";
import { createRunConfig, runConfig, useBuild } from "./store";
import styles from "./BuildTools.module.css";

export const useSbtTree = create<{ expanded: Set<string> | null }>(() => ({ expanded: null }));

const isRunnable = (n: SbtNode) => n.kind === "task" || n.kind === "runConfig";

/** Every expandable node's key (Expand All). */
export function sbtExpandableKeys(builds: readonly SbtBuild[]): Set<string> {
  const configs = useBuild.getState().configs;
  const out = new Set<string>();
  const walk = (nodes: readonly SbtNode[]) => {
    for (const n of nodes) {
      const kids = sbtChildren(n, configs);
      if (!kids?.length) continue;
      out.add(n.key);
      walk(kids);
    }
  };
  walk(sbtRoots(builds));
  return out;
}

/** Memoised children lookup (node objects stay stable while the model is unchanged). */
function childrenOf(configs: readonly RunConfig[]) {
  const cache = new Map<string, SbtNode[] | undefined>();
  return (n: SbtNode) => {
    if (!cache.has(n.key)) cache.set(n.key, sbtChildren(n, configs));
    return cache.get(n.key);
  };
}

function NodeRow({ node, state }: { node: SbtNode; state: TreeRowState }) {
  const detail =
    node.kind === "project" && node.project.root && node.build.version ? `sbt ${node.build.version}` : null;
  return (
    <span className={styles.row}>
      <Icon name={sbtIcon(node)} size={16} className={styles.icon} />
      <span className={clsx(styles.label, state.selected && styles.selectedLabel)}>
        {node.kind === "tasks" || node.kind === "runConfigs" ? <T>{sbtLabel(node)}</T> : sbtLabel(node)}
      </span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </span>
  );
}

export function SbtView() {
  const builds = useBuild((s) => s.model?.sbt);
  const configs = useBuild((s) => s.configs);
  const loading = useBuild((s) => s.loading);
  const error = useBuild((s) => s.error);
  const stored = useSbtTree((s) => s.expanded);
  const root = useProject((s) => s.project?.root ?? "");
  const [selection, setSelection] = useState<SbtNode[]>([]);

  const roots = useMemo(() => sbtRoots(builds ?? []), [builds]);
  const getChildren = useMemo(() => childrenOf(configs), [configs]);
  // Builds and their root projects start expanded.
  const expanded = useMemo(() => stored ?? new Set(roots.map((n) => n.key)), [stored, roots]);
  useEffect(() => {
    if (!stored && roots.length) useSbtTree.setState({ expanded: new Set(roots.map((n) => n.key)) });
  }, [stored, roots]);

  const nodesByKey = useCallback(
    (keys: Set<string>) => {
      const out: SbtNode[] = [];
      const walk = (nodes: readonly SbtNode[]) => {
        for (const n of nodes) {
          if (keys.has(n.key)) out.push(n);
          if (expanded.has(n.key)) walk(getChildren(n) ?? []);
        }
      };
      walk(roots);
      return out;
    },
    [roots, expanded, getChildren],
  );

  const selected = sbtNodeConfig(selection.filter(isRunnable));

  const contextMenu = (node: SbtNode | null, keys: Set<string>, e: MouseEvent) => {
    if (!node) return;
    e.preventDefault();
    const nodes = keys.has(node.key) ? nodesByKey(keys) : [node];
    const items: MenuItem[] = [];
    const config = isRunnable(node) ? sbtNodeConfig(nodes.filter(isRunnable)) : null;
    if (config) {
      items.push({ label: tx`Run '${config.name}'`, icon: "run", run: () => runConfig(config, "run") });
      if (node.kind === "runConfig")
        items.push({ kind: "action", action: "run.editConfigs", arg: node.config.id, label: "Edit Configuration…" });
      else items.push({ label: "Create Run Configuration…", icon: "edit", run: () => void createRunConfig(config) });
    }
    if (node.kind === "project") {
      const dir = [node.build.dir, node.project.root ? "" : node.project.dir].filter(Boolean).join("/");
      const base = /^(?:[A-Za-z]:[\\/]|\/)/.test(dir) ? dir : [root, dir].filter(Boolean).join("/");
      if (node.project.root)
        items.push({
          label: "Open build.sbt",
          icon: "file-scala",
          run: () => void editorService().openFile(`${base}/build.sbt`),
        });
      items.push({ kind: "action", action: "sbt.reload" });
    }
    if (items.length) showContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  if (!builds) {
    return (
      <div className={styles.view}>
        <div className={styles.loading}>
          {error ? (
            error
          ) : loading ? (
            <>
              <Spinner size={14} /> <T>Loading…</T>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.toolbar} role="toolbar" aria-label="sbt actions">
        <IconButton icon="refresh" size="small" iconSize={16} action="sbt.reload" />
        <span className={styles.sep} />
        <IconButton
          icon="run"
          size="small"
          iconSize={16}
          title="Run sbt Task"
          disabled={!selected}
          onClick={() => selected && runConfig(selected, "run")}
        />
        <span className={styles.sep} />
        <IconButton icon="expand-all" size="small" iconSize={16} action="sbt.expandAll" />
        <IconButton icon="collapse-all" size="small" iconSize={16} action="sbt.collapseAll" />
      </div>
      <div className={styles.body}>
        <Tree<SbtNode>
          roots={roots}
          getKey={(n) => n.key}
          getLabel={sbtLabel}
          getChildren={getChildren}
          isExpandable={(n) => !!getChildren(n)?.length}
          expanded={expanded}
          onExpandedChange={(next) => useSbtTree.setState({ expanded: next })}
          onSelectionChange={(keys) => setSelection(nodesByKey(keys))}
          renderNode={(n, state) => <NodeRow node={n} state={state} />}
          onActivate={(n) => {
            const config = isRunnable(n) ? sbtNodeConfig([n]) : null;
            if (config) runConfig(config, "run");
          }}
          onContextMenu={contextMenu}
          aria-label="sbt projects"
          empty={<EmptyState title="No sbt projects" />}
        />
      </div>
    </div>
  );
}
