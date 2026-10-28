import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import type { FileMatches } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import { notifications, useOccurrenceNavigator } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { basename, openLocation, relDir } from "../common/open";
import { CodePreview, MatchText, type PreviewHighlight } from "./parts";
import {
  NO_MARKS,
  confirmText,
  countUsages,
  groupState,
  loadReplacePreview,
  pendingUsages,
  replaceTargets,
  startReplace,
  summaryText,
  toggleExcluded,
  type ReplaceMarks,
  type ReplaceProgress,
  type ReplaceRun,
  type UsageGroup,
  type Usage,
} from "./replaceFlow";
import {
  closeFindTab,
  pinFindTab,
  rerunFindTab,
  stopFindTab,
  useFindViewOptions,
  useFindWindow,
  type FindTab,
} from "./windowStore";
import styles from "./FindToolWindow.module.css";
import { tx } from "@/platform/i18n";

type Node =
  | { kind: "dir"; key: string; label: string; count: number; children: Node[] }
  | { kind: "file"; key: string; path: string; name: string; dir: string; count: number; children: Node[] }
  | {
      kind: "match";
      key: string;
      path: string;
      line: number;
      col: number;
      endCol: number;
      text: string;
      /** Column of `text` in the real line. */
      textCol: number;
      ranges: Array<[number, number]>;
      starts: Array<{ line: number; col: number }>;
    };

/**
 * Streamed file matches as file → line nodes, flat and sorted by path (IDEA's
 * default), or under their directory with `groupByDirectory`.
 */
export function buildFindTree(files: readonly FileMatches[], groupByDirectory = false): Node[] {
  const dirs = new Map<string, Node & { kind: "dir" }>();
  const flat: Node[] = [];
  for (const f of files) {
    const dir = relDir(f.relPath);
    let d = dirs.get(dir);
    if (!d && groupByDirectory) {
      d = { kind: "dir", key: `d:${dir}`, label: dir || "/", count: 0, children: [] };
      dirs.set(dir, d);
    }
    const children: Node[] = f.matches.map((m) => {
      const lead = m.text.length - m.text.trimStart().length;
      const text = m.text.slice(lead).trimEnd();
      const first = m.ranges[0] ?? [0, 0];
      return {
        kind: "match",
        key: `m:${f.path}:${m.line}`,
        path: f.path,
        line: m.line,
        col: first[0] + m.textOffset,
        endCol: first[1] + m.textOffset,
        text,
        textCol: lead + m.textOffset,
        ranges: m.ranges
          .map(([s, e]) => [Math.max(0, s - lead), Math.min(text.length, e - lead)] as [number, number])
          .filter(([s, e]) => e > s),
        starts: m.ranges.map(([s]) => ({ line: m.line, col: s + m.textOffset })),
      };
    });
    const file: Node = {
      kind: "file",
      key: `f:${f.path}`,
      path: f.path,
      name: basename(f.relPath),
      dir,
      count: f.matches.length,
      children,
    };
    if (d) {
      d.children.push(file);
      d.count += f.matches.length;
    } else flat.push(file);
  }
  if (!groupByDirectory) {
    const rel = (n: Node) => (n.kind === "file" ? (n.dir ? `${n.dir}/${n.name}` : n.name) : "");
    return flat.sort((a, b) => rel(a).localeCompare(rel(b)));
  }
  return [...dirs.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Preview target of a node: a match, or a file's first match. */
function previewOf(node: Node | null): { path: string; line: number } | null {
  if (!node || node.kind === "dir") return null;
  if (node.kind === "match") return { path: node.path, line: node.line };
  const first = node.children[0];
  return first?.kind === "match" ? { path: node.path, line: first.line } : null;
}

/** The usages under a node (itself for a match). */
export function nodeGroups(node: Node): UsageGroup[] {
  if (node.kind === "match") return [{ key: node.key, path: node.path, starts: node.starts }];
  return node.children.flatMap(nodeGroups);
}

/** Excluded (⌫) / replaced usages per Find tab. */
const useMarks = create<{ byTab: Record<number, ReplaceMarks> }>(() => ({ byTab: {} }));
const setMarks = (tab: number, marks: ReplaceMarks) =>
  useMarks.setState((s) => ({ byTab: { ...s.byTab, [tab]: marks } }));

const useCollapsed = create<{ byTab: Record<number, ReadonlySet<string>> }>(() => ({ byTab: {} }));
const setCollapsed = (tab: number, keys: ReadonlySet<string>) =>
  useCollapsed.setState((s) => ({ byTab: { ...s.byTab, [tab]: keys } }));

function allExpandableKeys(nodes: readonly Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.kind === "match") continue;
    out.add(n.key);
    allExpandableKeys(n.children, out);
  }
  return out;
}

/** Search tabs in the tool window header. */
export function FindTabs() {
  const tabs = useFindWindow((s) => s.tabs);
  const activeId = useFindWindow((s) => s.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  if (!tab) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Searches"
      items={tabs.map((t) => ({
        id: String(t.id),
        label: t.title,
        closable: true,
        icon: t.pinned ? "pin" : undefined,
      }))}
      activeId={String(tab.id)}
      onSelect={(id) => useFindWindow.setState({ active: Number(id) })}
      onClose={(id) => closeFindTab(Number(id))}
      onContextMenu={(id, e) => {
        const t = tabs.find((x) => x.id === Number(id));
        if (!t) return;
        showContextMenu(e, [
          { id: "pin", label: t.pinned ? "Unpin Tab" : "Pin Tab", run: () => pinFindTab(t.id, !t.pinned) },
          { kind: "separator" },
          { id: "close", label: "Close Tab", run: () => closeFindTab(t.id) },
          {
            id: "closeOthers",
            label: "Close Other Tabs",
            disabled: tabs.length < 2,
            run: () => tabs.forEach((o) => o.id !== t.id && closeFindTab(o.id)),
          },
        ]);
      }}
    />
  );
}

export function FindToolWindow() {
  const tabs = useFindWindow((s) => s.tabs);
  const activeId = useFindWindow((s) => s.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  if (!tab) {
    return (
      <EmptyState title="No search results" icon="search">
        {tx`Use Find in Files (${shortcutLabel("find.inPath") ?? "⇧⌘F"}) and choose “Open in Find Window”.`}
      </EmptyState>
    );
  }
  return (
    <div className={styles.root}>
      <FindTabView key={tab.id} tab={tab} />
    </div>
  );
}

function FindTabView({ tab }: { tab: FindTab }) {
  const groupByDirectory = useFindViewOptions((o) => o.groupByDirectory);
  const showPreview = useFindViewOptions((o) => o.preview);
  const roots = useMemo(() => buildFindTree(tab.state.files, groupByDirectory), [tab.state.files, groupByDirectory]);
  const tree = useRef<TreeHandle>(null);
  const [leadNode, setLeadNode] = useState<Node | null>(null);
  const collapsed = useCollapsed((s) => s.byTab[tab.id]);
  const expanded = useMemo(() => {
    const all = allExpandableKeys(roots);
    if (collapsed) for (const k of collapsed) all.delete(k);
    return all;
  }, [roots, collapsed]);
  const st = tab.state;
  const marks = useMarks((m) => m.byTab[tab.id]) ?? NO_MARKS;
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<ReplaceRun | null>(null);
  const [progress, setProgress] = useState<ReplaceProgress | null>(null);
  const busy = !!running;
  const allGroups = useMemo(() => roots.flatMap(nodeGroups), [roots]);
  const byKey = useMemo(() => {
    const map = new Map<string, Node>();
    const walk = (list: readonly Node[]) =>
      list.forEach((n) => {
        map.set(n.key, n);
        if (n.kind !== "match") walk(n.children);
      });
    walk(roots);
    return map;
  }, [roots]);
  const selectedGroups = () => [...selection].flatMap((k) => (byKey.get(k) ? nodeGroups(byKey.get(k)!) : []));

  const exclude = () => {
    const groups = selectedGroups();
    if (!groups.length) return;
    const next = toggleExcluded(marks, groups);
    setMarks(tab.id, next);
    // Excluding moves on to the next usage, as in IDEA (including keeps the selection).
    if (groups.some((g) => groupState(g, next) === "excluded"))
      tree.current?.selectOccurrence(1, { skipSubtree: true });
  };

  useOccurrenceNavigator("find", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "match") return null;
    void openLocation(n.path, { line: n.line, col: n.col, endLine: n.line, endCol: n.endCol }, { focus });
    return step;
  });

  const preview = previewOf(leadNode);
  const highlights = useMemo<PreviewHighlight[]>(() => {
    const f = preview && st.files.find((x) => x.path === preview.path);
    return (f?.matches ?? []).map((m) => ({
      line: m.line,
      ranges: m.ranges.map(([a, b]) => [a + m.textOffset, b + m.textOffset] as [number, number]),
    }));
  }, [preview?.path, st.files]); // eslint-disable-line react-hooks/exhaustive-deps

  const replace = async (usages: Usage[]) => {
    if (tab.replacement === null || !usages.length || running) return;
    const run = startReplace(
      {
        query: tab.query,
        replacement: tab.replacement,
        preserveCase: !!tab.preserveCase,
        targets: replaceTargets(usages),
      },
      setProgress,
    );
    setRunning(run);
    try {
      const summary = await run.result;
      notifications().notify({
        group: "search",
        level: summary.failed ? "warning" : "info",
        title: summaryText(summary),
        key: "search.replace",
      });
      // Replaced usages disappear from the view, as in IDEA; exclusions are kept.
      rerunFindTab(tab.id);
    } catch (e) {
      notifications().notify({
        group: "search",
        level: "error",
        title: "Replace failed",
        body: String((e as Error)?.message ?? e),
      });
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const previewReplace = async () => {
    if (tab.replacement === null) return;
    const groups = selectedGroups();
    const path = groups[0]?.path;
    if (!path) return;
    const usages = pendingUsages(
      groups.filter((g) => g.path === path),
      marks,
    );
    try {
      const p = await loadReplacePreview(tab.query, tab.replacement, !!tab.preserveCase, path, usages);
      await executeAction("diff.compareTexts", {
        path,
        title: `Replace Preview`,
        left: { text: p.before, label: "Original" },
        right: { text: p.after, label: "After Replace" },
        line: usages[0]?.line,
      });
    } catch (e) {
      notifications().notify({
        group: "search",
        level: "error",
        title: "Preview failed",
        body: String((e as Error)?.message ?? e),
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      exclude();
    }
  };

  const replaceMode = tab.replacement !== null;
  const allPending = pendingUsages(allGroups, marks);
  const confirmReplaceAll = async () => {
    const ok = await confirm({
      title: "Replace All",
      ok: "Replace",
      message: (
        <>
          {confirmText(countUsages(allPending), tab.query.pattern, tab.replacement ?? "")}
          {marks.excluded.size > 0 && (
            <>
              {" "}
              <T>Excluded usages are skipped.</T>
            </>
          )}
        </>
      ),
    });
    if (ok) void replace(allPending);
  };
  const selectedPending = pendingUsages(selectedGroups(), marks);

  return (
    <div className={styles.body} onKeyDown={onKeyDown}>
      <div className={styles.summary}>
        {(st.status === "searching" || busy) && <Spinner size={12} />}
        <span className={styles.title}>{tab.title}</span>
        <span className={styles.count}>
          {st.status === "invalid" || st.status === "error"
            ? (st.error ?? tx("Search failed"))
            : progress
              ? tx`Replacing… ${progress.done}/${progress.total} files`
              : tx`${`${st.matchCount}${st.summary?.limitHit ? "+" : ""}`} matches in ${st.files.length} files` +
                (marks.excluded.size ? ` · ${tx`${marks.excluded.size} excluded`}` : "")}
        </span>
        <span className={styles.spacer} />
        <Button size="small" variant="ghost" disabled={!selection.size} onClick={exclude} title="Exclude / include (⌫)">
          <T>Exclude</T>
        </Button>
        {replaceMode && (
          <>
            {running && (
              <Button size="small" onClick={() => running.cancel()}>
                <T>Stop</T>
              </Button>
            )}
            <Button
              size="small"
              variant="ghost"
              disabled={!selection.size || busy}
              onClick={() => void previewReplace()}
            >
              <T>Preview</T>
            </Button>
            <Button
              size="small"
              disabled={!selectedPending.length || busy}
              onClick={() => void replace(selectedPending)}
            >
              <T>Replace Selected</T>
            </Button>
            <Button
              size="small"
              disabled={busy || !allPending.length || st.status === "searching"}
              onClick={() => void confirmReplaceAll()}
            >
              <T>Replace All</T>
            </Button>
          </>
        )}
      </div>
      <SplitGroup orientation="horizontal" className={styles.split} id="find-results-split">
        <SplitPanel id="results" minSize={120} className={styles.splitPanel}>
          <Tree<Node>
            className={styles.tree}
            aria-label="Find results"
            handleRef={tree}
            roots={roots}
            getKey={(n) => n.key}
            getLabel={(n) => (n.kind === "dir" ? n.label : n.kind === "file" ? n.name : n.text)}
            getChildren={(n) => (n.kind === "match" ? undefined : n.children)}
            isExpandable={(n) => n.kind !== "match"}
            isOccurrence={(n) => n.kind === "match" && groupState(nodeGroups(n)[0]!, marks) !== "excluded"}
            expanded={expanded}
            onExpandedChange={(next) => {
              const all = allExpandableKeys(roots);
              setCollapsed(tab.id, new Set([...all].filter((k) => !next.has(k))));
            }}
            selected={selection}
            onSelectionChange={(next, lead) => {
              setSelection(next);
              setLeadNode(lead);
            }}
            multiSelect
            onActivate={(n) => {
              if (n.kind === "match")
                void openLocation(
                  n.path,
                  { line: n.line, col: n.col, endLine: n.line, endCol: n.endCol },
                  { focus: true },
                );
              else if (n.kind === "file") void openLocation(n.path, previewOf(n) ? { line: previewOf(n)!.line } : null);
            }}
            onContextMenu={(_n, sel, e) => {
              const groups = [...sel].flatMap((k) => (byKey.get(k) ? nodeGroups(byKey.get(k)!) : []));
              const excludedAll = groups.length > 0 && groups.every((g) => groupState(g, marks) === "excluded");
              showContextMenu(e, [
                {
                  id: "exclude",
                  label: excludedAll ? "Include" : "Exclude",
                  shortcut: "⌫",
                  disabled: !groups.length,
                  run: exclude,
                },
                ...(replaceMode
                  ? [
                      {
                        id: "replace",
                        label: "Replace Selected",
                        disabled: busy || !pendingUsages(groups, marks).length,
                        run: () => void replace(pendingUsages(groups, marks)),
                      },
                      {
                        id: "preview",
                        label: "Preview Replacement",
                        disabled: busy || !groups.length,
                        run: () => void previewReplace(),
                      },
                    ]
                  : []),
              ]);
            }}
            activateExpandable={false}
            renderNode={(n, s) => <FindNode node={n} state={s} tab={tab} marks={marks} />}
            empty={
              <span className={styles.empty}>
                {st.status === "searching" || st.status === "validating" ? "Searching…" : "No matches"}
              </span>
            }
          />
        </SplitPanel>
        {showPreview && (
          <>
            <SplitHandle />
            <SplitPanel id="preview" minSize={120} defaultSize="45%" className={styles.splitPanel}>
              <CodePreview path={preview?.path ?? null} line={preview?.line ?? 0} highlights={highlights} />
            </SplitPanel>
          </>
        )}
      </SplitGroup>
    </div>
  );
}

function FindNode({ node, state, tab, marks }: { node: Node; state: TreeRowState; tab: FindTab; marks: ReplaceMarks }) {
  const excluded = nodeGroups(node).every((g) => groupState(g, marks) === "excluded");
  return (
    <span className={clsx(styles.nodeWrap, excluded && styles.excluded)}>
      <FindNodeContent node={node} state={state} tab={tab} />
    </span>
  );
}

function FindNodeContent({ node, state, tab }: { node: Node; state: TreeRowState; tab: FindTab }) {
  switch (node.kind) {
    case "dir":
      return (
        <span className={styles.node}>
          <Icon name={state.expanded ? "folder-open" : "folder"} size={14} className={styles.icon} />
          <span className={styles.label}>{node.label}</span>
          <span className={styles.meta}>
            {node.count} {node.count === 1 ? "match" : "matches"}
          </span>
        </span>
      );
    case "file":
      return (
        <span className={styles.node}>
          <Icon name={fileIconName(node.name)} size={14} className={styles.icon} />
          <span className={styles.label}>{node.name}</span>
          <span className={styles.meta}>{node.count}</span>
          {!state.depth && node.dir && <span className={styles.meta}>{node.dir}</span>}
        </span>
      );
    case "match":
      return (
        <span className={styles.node}>
          <span className={styles.lineNo}>{node.line + 1}</span>
          <span className={styles.code}>
            <MatchText
              text={node.text}
              ranges={node.ranges}
              source={{ path: node.path, line: node.line, col: node.textCol }}
              active={state.selected}
              replacement={tab.replacement}
              query={tab.query}
              preserveCase={!!tab.preserveCase}
            />
          </span>
        </span>
      );
  }
}

/** Header controls of the Find tool window. */
export function FindToolWindowActions() {
  const tabs = useFindWindow((s) => s.tabs);
  const activeId = useFindWindow((s) => s.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  if (!tab) return null;
  const searching = tab.state.status === "searching";
  return (
    <>
      <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" />
      <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" />
      {searching ? (
        <IconButton icon="stop" title="Stop" size="small" onClick={() => stopFindTab(tab.id)} />
      ) : (
        <IconButton
          icon="refresh"
          title="Rerun"
          shortcut={shortcutLabel("find.rerun")}
          size="small"
          onClick={() => rerunFindTab(tab.id)}
        />
      )}
      <IconButton icon="expand-all" title="Expand All" size="small" onClick={() => setCollapsed(tab.id, new Set())} />
      <IconButton
        icon="collapse-all"
        title="Collapse All"
        size="small"
        onClick={() =>
          setCollapsed(
            tab.id,
            allExpandableKeys(buildFindTree(tab.state.files, useFindViewOptions.getState().groupByDirectory)),
          )
        }
      />
      <IconButton icon="close" title="Close Tab" size="small" onClick={() => closeFindTab(tab.id)} />
    </>
  );
}
