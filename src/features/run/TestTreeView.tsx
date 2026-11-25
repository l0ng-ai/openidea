import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { executeAction, getAction } from "@/platform/actions";
import {
  findOccurrence,
  Icon,
  IconButton,
  Menu,
  showContextMenu,
  useContextMenuStore,
  Spinner,
  Toolbar,
  Tree,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { useOccurrenceNavigator } from "@/workbench/contributions";
import { openTarget, resolveTarget } from "./navigate";
import {
  formatDuration,
  nodeDuration,
  nodeOutput,
  nodeStatus,
  type TestNode,
  type TestResults,
  type TestStatus,
} from "./testing";
import { parseComparison } from "./testing/comparison";
import { TEST_TREE_FOCUS, testTree } from "./testTree";
import { ExportTestResultsDialog } from "./ExportTestResultsDialog";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

const DIAGNOSE = "agents.diagnoseTestFailure";

/** Test tree filters and sorting, kept across runs and restarts (IDEA hides passed tests by default). */
const FILTERS_KEY = "openidea.run.testFilters";

interface TestFilters {
  showPassed: boolean;
  showIgnored: boolean;
  showDurations: boolean;
  sortAlphabetically: boolean;
  sortByDuration: boolean;
}

export function loadTestFilters(): TestFilters {
  try {
    const raw = globalThis.localStorage?.getItem(FILTERS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<TestFilters>) : {};
    return {
      showPassed: v.showPassed === true,
      showIgnored: v.showIgnored !== false,
      showDurations: v.showDurations !== false,
      sortAlphabetically: v.sortAlphabetically === true && v.sortByDuration !== true,
      sortByDuration: v.sortByDuration === true,
    };
  } catch {
    return {
      showPassed: false,
      showIgnored: true,
      showDurations: true,
      sortAlphabetically: false,
      sortByDuration: false,
    };
  }
}

function saveTestFilters(f: TestFilters) {
  try {
    globalThis.localStorage?.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch {
    /* storage unavailable */
  }
}

/** "Show Diff" for an assertion failure: Expected on the left, Actual on the right. */
export function showTestDiff(node: TestNode): boolean {
  const c = parseComparison(node.output);
  if (!c) return false;
  void executeAction("diff.compareTexts", {
    path: `${node.path.join("/")}.txt`,
    title: tx`Comparison Failure: ${node.name}`,
    left: { text: c.expected, label: c.labels?.expected ?? "Expected" },
    right: { text: c.actual, label: c.labels?.actual ?? "Actual" },
  });
  return true;
}

export function StatusIcon({ status }: { status: TestStatus | null }) {
  switch (status) {
    case "passed":
      return <Icon name="test-passed" className={styles.testStatus} label="Passed" />;
    case "failed":
      return <Icon name="test-failed" className={styles.testStatus} label="Failed" />;
    case "skipped":
      return <Icon name="test-ignored" className={styles.testStatus} label="Ignored" />;
    case "running":
      return <Spinner size={16} variant="spokes" className={styles.testStatus} />;
    default:
      return <Icon name="test-pending" className={styles.testStatus} label="Pending" />;
  }
}

export function TestStatusBar({
  results,
  version,
  running,
}: {
  results: TestResults;
  version: number;
  running: boolean;
}) {
  const counts = useMemo(() => results.counts(), [results, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const outcome = counts.failed ? "failed" : counts.passed ? "passed" : counts.skipped ? "skipped" : null;
  const duration = results.summary.durationMs;

  return (
    <div
      className={styles.testStatusBar}
      role="status"
      data-running={running || undefined}
      data-outcome={outcome ?? undefined}
    >
      <StatusIcon status={running ? "running" : outcome} />
      <span className={styles.testCounts}>
        {counts.failed > 0 && <span className={styles.failed}>{tx`${counts.failed} failing`}</span>}
        {counts.passed > 0 && <span>{tx`${counts.passed} passed`}</span>}
        {counts.skipped > 0 && <span className={styles.skipped}>{tx`${counts.skipped} ignored`}</span>}
        {!outcome && <span className={styles.skipped}>{running ? tx("Running…") : tx("No tests")}</span>}
        {duration !== undefined && <span className={styles.testTotalDuration}>{formatDuration(duration)}</span>}
      </span>
    </div>
  );
}

const isFailedTest = (n: TestNode) => n.children.length === 0 && nodeStatus(n) === "failed";

const treeModel = {
  getKey: (n: TestNode) => n.id,
  getChildren: (n: TestNode) => n.children,
  isExpandable: (n: TestNode) => n.children.length > 0,
  isOccurrence: isFailedTest,
};

function suiteIds(nodes: readonly TestNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.children.length === 0) continue;
    out.add(n.id);
    suiteIds(n.children, out);
  }
  return out;
}

function filterTree(nodes: readonly TestNode[], keep: (n: TestNode) => boolean): TestNode[] {
  const out: TestNode[] = [];
  for (const n of nodes) {
    if (n.children.length === 0) {
      if (keep(n)) out.push(n);
      continue;
    }
    const children = filterTree(n.children, keep);
    if (children.length > 0) out.push({ ...n, children });
  }
  return out;
}

/** IDEA's test tree sorts: by name (ignoring case, numbers by value), or slowest first with untimed nodes last. */
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: TestNode, b: TestNode) => names.compare(a.name, b.name);

function sortTree(nodes: readonly TestNode[], byDuration: boolean): TestNode[] {
  const sorted = nodes.map((n) => (n.children.length ? { ...n, children: sortTree(n.children, byDuration) } : n));
  if (!byDuration) return sorted.sort(byName);
  const duration = new Map(sorted.map((n) => [n, nodeDuration(n) ?? -1]));
  return sorted.sort((a, b) => duration.get(b)! - duration.get(a)!);
}

export interface TestTreeViewProps {
  results: TestResults;
  version: number;
  cwd: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  running: boolean;
  /** The run configuration's name (Export Test Results names the file after it). */
  name?: string;
  /** Run / Debug the selected tests (context menu); absent when the configuration can't be narrowed. */
  onRunTests?: (ids: string[], debug: boolean) => void;
  canRunTests?: (ids: string[]) => boolean | Promise<boolean>;
}

export function TestTreeView({
  results,
  version,
  cwd,
  selected,
  onSelect,
  running,
  name = "Tests",
  onRunTests,
  canRunTests,
}: TestTreeViewProps) {
  const [filters, setFilters] = useState(loadTestFilters);
  const { showPassed, showIgnored, showDurations, sortAlphabetically, sortByDuration } = filters;
  const toggle = (key: keyof TestFilters) =>
    setFilters((f) => {
      const next = { ...f, [key]: !f[key] };
      // The sorts replace each other, as in IDEA.
      if (key === "sortAlphabetically" && next.sortAlphabetically) next.sortByDuration = false;
      if (key === "sortByDuration" && next.sortByDuration) next.sortAlphabetically = false;
      saveTestFilters(next);
      return next;
    });
  const sortButton = useRef<HTMLButtonElement>(null);
  const [sortMenu, setSortMenu] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [moreMenu, setMoreMenu] = useState(false);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const tree = useRef<TreeHandle>(null);
  const selectedKeys = useMemo(
    () => (selected === null ? new Set<string>() : selection.has(selected) ? selection : new Set([selected])),
    [selected, selection],
  );

  const jumpToSource = (n: TestNode) => {
    const target = n.location ?? firstLocated(n)?.location;
    if (target) void openTarget(target, cwd, true);
  };

  // The agents feature's action: the failure becomes a draft the user reviews and sends.
  const diagnose = async (n: TestNode, name: string) => {
    const located = n.location ?? firstLocated(n)?.location;
    const path = located ? await resolveTarget(located, cwd).catch(() => null) : null;
    // Rust's `left` / `right` don't say which side is expected; the output excerpt shows them as written.
    const parsed = parseComparison(n.output);
    const comparison = parsed?.labels ? null : parsed;
    await executeAction(DIAGNOSE, {
      name,
      path,
      line: path ? located?.line : undefined,
      expected: comparison?.expected,
      actual: comparison?.actual,
      output: nodeOutput(n),
    });
  };

  const contextMenu = (node: TestNode | null, sel: Set<string>, e: MouseEvent) => {
    if (!node) return;
    const ids = sel.has(node.id) ? [...sel] : [node.id];
    const name = ids.length === 1 ? (results.get(ids[0]!)?.name ?? node.name) : `${ids.length} tests`;
    const located = node.location ?? firstLocated(node)?.location;
    e.preventDefault();
    const supported = onRunTests ? (canRunTests?.(ids) ?? true) : false;
    const itemsFor = (enabled: boolean) => {
      const items: MenuItem[] = [];
      if (onRunTests) {
        items.push(
          {
            label: tx`Run '${name}'`,
            verbatim: true,
            icon: "run",
            disabled: !enabled,
            run: () => onRunTests(ids, false),
          },
          {
            label: tx`Debug '${name}'`,
            verbatim: true,
            icon: "debug",
            disabled: !enabled,
            run: () => onRunTests(ids, true),
          },
          { kind: "separator" },
        );
      }
      if (ids.length === 1 && nodeStatus(node) === "failed" && parseComparison(node.output))
        items.push({ label: "Show Diff", icon: "diff", run: () => void showTestDiff(node) });
      if (ids.length === 1 && !node.children.length && nodeStatus(node) === "failed" && getAction(DIAGNOSE))
        items.push({ label: "Diagnose with Agent", icon: "toolwindow-agents", run: () => void diagnose(node, name) });
      items.push({
        label: "Jump to Source",
        icon: "external-link",
        shortcut: "F4",
        disabled: !located,
        run: () => jumpToSource(node),
      });
      return items;
    };
    showContextMenu(e, itemsFor(supported === true));
    if (supported instanceof Promise) {
      const menu = useContextMenuStore.getState().menu;
      void supported.then((enabled) => {
        if (useContextMenuStore.getState().menu === menu && menu)
          useContextMenuStore.setState({ menu: { ...menu, items: itemsFor(enabled) } });
      });
    }
  };

  // Like IDEA, Sort by Duration applies once the run has finished, so rows don't jump while tests report.
  const byDuration = sortByDuration && !running;
  const roots = useMemo(() => {
    const keep = (n: TestNode) => (showPassed || n.own !== "passed") && (showIgnored || n.own !== "skipped");
    const shown = showPassed && showIgnored ? [...results.roots] : filterTree(results.roots, keep);
    return byDuration || sortAlphabetically ? sortTree(shown, byDuration) : shown;
  }, [results, version, showPassed, showIgnored, sortAlphabetically, byDuration]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expand failed suites by default (IDEA reveals failures); the user's toggles win afterwards.
  const effectiveExpanded = useMemo(() => {
    if (expanded) return expanded;
    const set = new Set<string>();
    const visit = (nodes: readonly TestNode[], depth: number) => {
      for (const n of nodes) {
        if (n.children.length === 0) continue;
        if (depth === 0 || nodeStatus(n) === "failed") set.add(n.id);
        visit(n.children, depth + 1);
      }
    };
    visit(roots, 0);
    return set;
  }, [expanded, roots]);

  // Export Test Results waits for the run to finish.
  const canExport = !running && !results.isEmpty;
  // Collapse All leaves the top-level suites in view, as IDEA's test tree does.
  useEffect(() => {
    testTree.expandAll = () => setExpanded(suiteIds(results.roots));
    testTree.collapseAll = () => setExpanded(new Set());
    testTree.exportResults = canExport ? () => setExporting(true) : null;
    testTree.showDurations = showDurations;
    testTree.toggleDurations = () => toggle("showDurations");
    return () => {
      testTree.expandAll = null;
      testTree.collapseAll = null;
      testTree.exportResults = null;
      testTree.showDurations = null;
      testTree.toggleDurations = null;
    };
  });
  const hasSuites = roots.some((n) => n.children.length > 0);

  // Previous / Next Failed Test (⌘⌥↑ / ⌘⌥↓): like IDEA, stops at the first / last failure instead of wrapping.
  useOccurrenceNavigator("run", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    if (!step) return null;
    const n = step.node as TestNode;
    if (n.location) void openTarget(n.location, cwd, focus);
    return step;
  });
  const hasPrevFailed = findOccurrence(roots, selected, -1, treeModel) !== null;
  const hasNextFailed = findOccurrence(roots, selected, 1, treeModel) !== null;

  return (
    <div className={styles.testPane}>
      <Toolbar className={styles.testToolbar} aria-label="Test results">
        <div className={styles.testFilters}>
          <IconButton
            icon="test-show-passed"
            size="small"
            iconSize={16}
            title="Show Passed"
            pressed={showPassed}
            onClick={() => toggle("showPassed")}
          />
          <IconButton
            icon="test-show-ignored"
            size="small"
            iconSize={16}
            title="Show Ignored"
            pressed={showIgnored}
            onClick={() => toggle("showIgnored")}
          />
        </div>
        <IconButton
          ref={sortButton}
          icon="test-sort"
          size="small"
          iconSize={16}
          title="Sorting Options"
          aria-haspopup="menu"
          aria-expanded={sortMenu}
          pressed={sortAlphabetically || sortByDuration}
          onClick={() => setSortMenu((v) => !v)}
        />
        <Menu
          open={sortMenu}
          anchor={sortButton}
          items={[
            { label: "Sort Alphabetically", checked: sortAlphabetically, run: () => toggle("sortAlphabetically") },
            {
              label: "Sort by Duration",
              checked: sortByDuration,
              disabled: running,
              run: () => toggle("sortByDuration"),
            },
          ]}
          onClose={() => setSortMenu(false)}
        />
        <IconButton
          ref={moreButton}
          icon="more-horizontal"
          size="small"
          iconSize={16}
          title="More Actions"
          aria-haspopup="menu"
          aria-expanded={moreMenu}
          onClick={() => setMoreMenu((open) => !open)}
        />
        <Menu
          open={moreMenu}
          anchor={moreButton}
          onClose={() => setMoreMenu(false)}
          items={[
            {
              icon: "expand-all",
              label: "Expand All",
              disabled: !hasSuites,
              run: () => void executeAction("run.expandAllTests"),
            },
            {
              icon: "collapse-all",
              label: "Collapse All",
              disabled: !hasSuites,
              run: () => void executeAction("run.collapseAllTests"),
            },
            { kind: "separator" },
            {
              kind: "action",
              action: "navigate.prevOccurrence",
              label: "Previous Failed Test",
              disabled: !hasPrevFailed,
            },
            {
              kind: "action",
              action: "navigate.nextOccurrence",
              label: "Next Failed Test",
              disabled: !hasNextFailed,
            },
            { kind: "separator" },
            {
              icon: "export",
              label: "Export Test Results…",
              disabled: !canExport,
              run: () => setExporting(true),
            },
            { kind: "separator" },
            {
              label: "Test Runner Options",
              icon: "settings",
              submenu: [{ kind: "action", action: "run.toggleTestDurations" }],
            },
          ]}
        />
      </Toolbar>
      {exporting && (
        <ExportTestResultsDialog results={results} name={name} cwd={cwd} onClose={() => setExporting(false)} />
      )}
      <Tree<TestNode>
        aria-label="Test results"
        className={styles.testTree}
        handleRef={tree}
        focusContext={TEST_TREE_FOCUS}
        roots={roots}
        getKey={(n) => n.id}
        getLabel={(n) => n.name}
        getChildren={(n) => (n.children.length ? n.children : undefined)}
        isExpandable={(n) => n.children.length > 0}
        isOccurrence={isFailedTest}
        expanded={effectiveExpanded}
        onExpandedChange={(next) => setExpanded(next)}
        selected={selectedKeys}
        // A click only selects (shows the test's output); double-click / Enter / F4 jump to the source, as in IDEA.
        onSelectionChange={(sel, lead) => {
          setSelection(sel);
          onSelect(lead?.id ?? null);
        }}
        activateExpandable
        onActivate={jumpToSource}
        onContextMenu={contextMenu}
        renderNode={(n) => {
          const s = nodeStatus(n);
          const d = showDurations ? nodeDuration(n) : undefined;
          return (
            <span className={styles.testRow}>
              <StatusIcon status={s} />
              <span className={clsx(styles.testName, s === "skipped" && styles.skipped)} title={n.name}>
                {n.name}
              </span>
              {d !== undefined && <span className={styles.testDuration}>{formatDuration(d)}</span>}
            </span>
          );
        }}
        empty={
          <div className={styles.testEmpty}>
            {running
              ? tx("Waiting for test results…")
              : results.isEmpty
                ? tx("No test results")
                : tx("Passed tests are hidden")}
          </div>
        }
      />
    </div>
  );
}

function firstLocated(node: TestNode): TestNode | undefined {
  if (node.location) return node;
  for (const c of node.children) {
    if (nodeStatus(c) !== "failed") continue;
    const hit = firstLocated(c);
    if (hit) return hit;
  }
  return undefined;
}
