/** "hierarchy" tool window: call hierarchy (⌃⌥H) and type hierarchy (⌃H). */
import { openCodeLocation } from "@/editor/api";
import { useCallback, useMemo, useRef } from "react";
import { create } from "zustand";
import { basename, relativePath, useProject } from "@/platform/project";
import { useOccurrenceNavigator } from "@/workbench/contributions";
import {
  EmptyState,
  IconButton,
  Spinner,
  SymbolBadge,
  Tabs,
  showContextMenu,
  Tree,
  badgeKind,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import { openLocation } from "./ipc";
import {
  closeHierarchyTab,
  pinHierarchyTab,
  ROOT_ID,
  selectHierarchyTab,
  tabHierarchy,
  directionLabel,
  hierarchyTitle,
  hierarchyTarget,
  loadChildren,
  prefetchLevels,
  refreshHierarchy,
  noneFoundLabel,
  setDirection,
  useHierarchy,
  type HierarchyNode,
} from "./hierarchy";
import styles from "./HierarchyView.module.css";
import { tx } from "@/platform/i18n";

type Node = { kind: "root"; id: string } | { kind: "item"; id: string; node: HierarchyNode };

const OPTIONS_KEY = "openidea.hierarchy.view.v1";

/** Autoscroll to Source: selecting a node shows it in the editor (IDEA: off). Persisted. */
export const useHierarchyOptions = create<{ autoscroll: boolean }>(() => {
  try {
    return { autoscroll: false, ...JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") };
  } catch {
    return { autoscroll: false };
  }
});

useHierarchyOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

/** Tool window header: the `Callers of foo` content tabs. */
export function HierarchyTabs() {
  const state = useHierarchy();
  const tabs = state.tabs.flatMap((tab) => {
    const h = tabHierarchy(state, tab);
    return h.root ? [{ tab, label: hierarchyTitle(h.mode, h.direction, h.root.name) }] : [];
  });
  if (!tabs.length || state.active === null) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Hierarchies"
      items={tabs.map(({ tab, label }) => ({ id: String(tab.id), label, closable: true, pinned: tab.pinned }))}
      activeId={String(state.active)}
      onSelect={(id) => selectHierarchyTab(Number(id))}
      onClose={(id) => closeHierarchyTab(Number(id))}
      onTogglePin={(id) => {
        const tab = tabs.find((t) => t.tab.id === Number(id))?.tab;
        if (tab) pinHierarchyTab(tab.id, !tab.pinned);
      }}
      onContextMenu={(id, e) => {
        const tab = tabs.find((t) => t.tab.id === Number(id))?.tab;
        if (!tab) return;
        // IDEA's content tab menu.
        showContextMenu(e, [
          { id: "close", label: "Close Tab", run: () => closeHierarchyTab(tab.id) },
          { id: "closeAll", label: "Close All Tabs", run: () => tabs.forEach((t) => closeHierarchyTab(t.tab.id)) },
          {
            id: "closeOthers",
            label: "Close Other Tabs",
            disabled: tabs.length < 2,
            run: () => tabs.forEach((t) => t.tab.id !== tab.id && closeHierarchyTab(t.tab.id)),
          },
          { kind: "separator" },
          { id: "pin", label: tab.pinned ? "Unpin Tab" : "Pin Tab", run: () => pinHierarchyTab(tab.id, !tab.pinned) },
        ]);
      }}
    />
  );
}

function HierarchyToolbar() {
  const mode = useHierarchy((s) => s.mode);
  const direction = useHierarchy((s) => s.direction);
  const autoscroll = useHierarchyOptions((s) => s.autoscroll);
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Hierarchy actions")}>
      <div className={styles.toolbarGroup}>
        <IconButton
          icon="arrow-up"
          size="small"
          iconSize={16}
          title={tx`${directionLabel(mode, "incoming")} Hierarchy`}
          pressed={direction === "incoming"}
          onClick={() => setDirection("incoming")}
        />
        <IconButton
          icon="arrow-down"
          size="small"
          iconSize={16}
          title={tx`${directionLabel(mode, "outgoing")} Hierarchy`}
          pressed={direction === "outgoing"}
          onClick={() => setDirection("outgoing")}
        />
      </div>
      <IconButton icon="refresh" size="small" iconSize={16} title="Refresh" onClick={refreshHierarchy} />
      <div className={styles.toolbarGroup}>
        <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" iconSize={16} />
        <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" iconSize={16} />
        <IconButton
          icon="autoscroll-to-source"
          size="small"
          iconSize={16}
          title="Autoscroll to Source"
          pressed={autoscroll}
          onClick={() => useHierarchyOptions.setState({ autoscroll: !autoscroll })}
        />
      </div>
    </div>
  );
}

export function HierarchyView() {
  const { mode, direction, root, children, failed, notes, loading, expanded, generation } = useHierarchy();
  const projectRoot = useProject((s) => s.project?.root ?? "");
  const roots = useMemo<Node[]>(() => (root ? [{ kind: "root", id: ROOT_ID }] : []), [root]);

  const getChildren = useCallback(
    (n: Node): Node[] | undefined => children.get(n.id)?.map((c) => ({ kind: "item", id: c.id, node: c }) as Node),
    [children],
  );
  const isExpandable = useCallback(
    (n: Node) => {
      const loaded = children.get(n.id);
      return loaded === undefined || loaded.length > 0;
    },
    [children],
  );
  const tree = useRef<TreeHandle>(null);
  const targetOf = (n: Node) => {
    if (n.kind === "item") return hierarchyTarget(mode, direction, n.node.item);
    return root ? { path: root.path, line: root.line, col: root.col } : null;
  };
  const show = (n: Node, focus: boolean) => {
    const t = targetOf(n);
    if (t) void openCodeLocation(t.path, { line: t.line, col: t.col }, { focus });
  };

  // Every node is an occurrence, as in IDEA's hierarchy views.
  useOccurrenceNavigator("hierarchy", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    if (!step) return null;
    show(step.node as Node, focus);
    return step;
  });

  if (!root)
    return (
      <EmptyState>
        <T>Use Call Hierarchy (⌃⌥H) or Type Hierarchy (⌃H) on a symbol to see its hierarchy here</T>
      </EmptyState>
    );

  const renderNode = (n: Node, _state: TreeRowState) => {
    if (n.kind === "root") {
      return (
        <span className={styles.row} title={`${root.name}\n${relativePath(projectRoot, root.path)}:${root.line + 1}`}>
          <SymbolBadge kind={mode === "call" ? "function" : "class"} />
          <span className={styles.name}>{root.name}</span>
          {loading && <Spinner size={12} />}
          {failed.has(ROOT_ID) && (
            <span className={styles.error}>
              <T>failed to load</T>
            </span>
          )}
          {!loading && !failed.has(ROOT_ID) && children.get(ROOT_ID)?.length === 0 && (
            <span className={styles.muted}>{noneFoundLabel(mode, direction)}</span>
          )}
          {root.detail && <span className={styles.muted}>{root.detail}</span>}
          <span className={styles.muted}>
            {basename(root.path)}:{root.line + 1}
          </span>
        </span>
      );
    }
    const { item } = n.node;
    const calls = item.fromRanges.length;
    return (
      <span
        className={styles.row}
        title={`${item.name}\n${relativePath(projectRoot, item.path)}:${item.selectionRange.start.line + 1}`}
      >
        <SymbolBadge kind={badgeKind(item.kind)} />
        <span className={styles.name}>{item.name}</span>
        {calls > 1 && <span className={styles.muted}>{tx`(${calls} calls)`}</span>}
        {n.node.recursion && (
          <span className={styles.muted}>
            <T>recursive</T>
          </span>
        )}
        {failed.has(n.id) && (
          <span className={styles.error}>
            <T>failed to load</T>
          </span>
        )}
        {item.detail && <span className={styles.muted}>{item.detail}</span>}
        <span className={styles.muted}>
          {basename(item.path)}:{item.selectionRange.start.line + 1}
        </span>
        {notes.has(n.id) && (
          <span className={styles.muted} title={notes.get(n.id)}>
            {notes.get(n.id)}
          </span>
        )}
      </span>
    );
  };

  return (
    <div className={styles.view}>
      <HierarchyToolbar />
      {notes.has(ROOT_ID) && (
        <div className={styles.note} role="note">
          {notes.get(ROOT_ID)}
        </div>
      )}
      <div className={styles.body}>
        <Tree<Node>
          key={generation}
          aria-label={mode === "call" ? "Call hierarchy" : "Type hierarchy"}
          horizontalScroll
          roots={roots}
          getKey={(n) => n.id}
          getLabel={(n) => (n.kind === "root" ? root.name : n.node.item.name)}
          getChildren={getChildren}
          isExpandable={isExpandable}
          loadChildren={(n) => (n.kind === "item" ? loadChildren(n.node) : undefined)}
          onExpandedChange={(opened, n, open) => {
            useHierarchy.setState({ expanded: [...opened] });
            const shown = open ? children.get(n.id) : undefined;
            if (shown) prefetchLevels(shown);
          }}
          defaultExpanded={expanded}
          handleRef={tree}
          isOccurrence={() => true}
          onSelectionChange={(_sel, n) => {
            if (n && useHierarchyOptions.getState().autoscroll) show(n, false);
          }}
          renderNode={renderNode}
          activateExpandable
          multiSelect={false}
          onActivate={(n) => {
            const target = n.kind === "root" ? root : hierarchyTarget(mode, direction, n.node.item);
            void openLocation(target.path, target.line, target.col);
          }}
        />
      </div>
    </div>
  );
}
