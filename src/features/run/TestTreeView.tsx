import { useMemo, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { Icon, IconButton, showContextMenu, useContextMenuStore, Spinner, Tree, type MenuItem } from "@/ui";
import { openTarget } from "./navigate";
import { nodeStatus, type TestNode, type TestResults, type TestStatus } from "./testing";
import { parseComparison } from "./testing/comparison";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

/** Test tree filters, kept across runs and restarts (IDEA hides passed tests by default). */
const FILTERS_KEY = "openidea.run.testFilters";

interface TestFilters {
  showPassed: boolean;
  showIgnored: boolean;
}

export function loadTestFilters(): TestFilters {
  try {
    const raw = globalThis.localStorage?.getItem(FILTERS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<TestFilters>) : {};
    return { showPassed: v.showPassed === true, showIgnored: v.showIgnored !== false };
  } catch {
    return { showPassed: false, showIgnored: true };
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

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace(/\.?0+$/, "")} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} m ${Math.round((ms % 60_000) / 1000)} s`;
}

function totalDuration(node: TestNode): number | undefined {
  if (node.durationMs !== undefined) return node.durationMs;
  let sum = 0;
  let any = false;
  for (const c of node.children) {
    const d = totalDuration(c);
    if (d !== undefined) {
      sum += d;
      any = true;
    }
  }
  return any ? sum : undefined;
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

export interface TestTreeViewProps {
  results: TestResults;
  version: number;
  cwd: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  running: boolean;
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
  onRunTests,
  canRunTests,
}: TestTreeViewProps) {
  const [filters, setFilters] = useState(loadTestFilters);
  const { showPassed, showIgnored } = filters;
  const toggle = (key: keyof TestFilters) =>
    setFilters((f) => {
      const next = { ...f, [key]: !f[key] };
      saveTestFilters(next);
      return next;
    });
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const selectedKeys = useMemo(
    () => (selected === null ? new Set<string>() : selection.has(selected) ? selection : new Set([selected])),
    [selected, selection],
  );

  const jumpToSource = (n: TestNode) => {
    const target = n.location ?? firstLocated(n)?.location;
    if (target) void openTarget(target, cwd, true);
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

  const counts = useMemo(() => results.counts(), [results, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const roots = useMemo(() => {
    const keep = (n: TestNode) => (showPassed || n.own !== "passed") && (showIgnored || n.own !== "skipped");
    return showPassed && showIgnored ? [...results.roots] : filterTree(results.roots, keep);
  }, [results, version, showPassed, showIgnored]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const status = running ? "running" : counts.failed > 0 ? "failed" : counts.total > 0 ? "passed" : null;
  const duration = results.summary.durationMs;

  return (
    <div className={styles.testPane}>
      <div className={styles.testHeader}>
        <StatusIcon status={status} />
        <span className={styles.testCounts}>
          {counts.failed > 0 && <span className={styles.failed}>{tx`${counts.failed} failing`}</span>}
          {counts.passed > 0 && <span>{tx`${counts.passed} passed`}</span>}
          {counts.skipped > 0 && <span className={styles.skipped}>{tx`${counts.skipped} ignored`}</span>}
          {counts.total === 0 && <span className={styles.skipped}>{running ? tx("Running…") : tx("No tests")}</span>}
          {duration !== undefined && <span className={styles.skipped}>{formatDuration(duration)}</span>}
        </span>
        <span className={styles.spacer} />
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
      <Tree<TestNode>
        aria-label="Test results"
        className={styles.testTree}
        roots={roots}
        getKey={(n) => n.id}
        getLabel={(n) => n.name}
        getChildren={(n) => (n.children.length ? n.children : undefined)}
        isExpandable={(n) => n.children.length > 0}
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
          const d = totalDuration(n);
          return (
            <span className={styles.testRow}>
              <StatusIcon status={s} />
              <span className={clsx(styles.testName, s === "skipped" && styles.skipped)}>{n.name}</span>
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
