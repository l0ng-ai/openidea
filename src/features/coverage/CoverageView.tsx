/** Coverage tool window: one tab per recent suite, a sortable tree of directories and files. */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { EmptyState, Icon, IconButton, Tabs, Tree, fileIconName, T } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { ColumnDivider } from "./ColumnDivider";
import { coverageColumns, readCoverageWidths, saveCoverageWidths } from "./columns";
import { coverageTree, formatPercent, sortTree, type CoverageNode, type SortKey } from "./model";
import { activeSuite, closeSuite, selectSuite, setCoverageVisible, useCoverage } from "./store";
import styles from "./Coverage.module.css";

export function CoverageTabs() {
  const suites = useCoverage((s) => s.suites);
  const activeId = useCoverage((s) => s.activeId);
  if (!suites.length) return null;
  return (
    <Tabs
      variant="compact"
      aria-label="Coverage suites"
      className={styles.tabs}
      activeId={activeId}
      onSelect={selectSuite}
      onClose={closeSuite}
      items={suites.map((s) => ({
        id: s.id,
        label: s.name,
        closable: true,
        tooltip: `${s.data.runner}, ${new Date(s.createdAt).toLocaleTimeString()}`,
      }))}
    />
  );
}

export function CoverageHeaderActions() {
  const visible = useCoverage((s) => s.visible);
  const hasSuite = useCoverage((s) => !!s.activeId);
  return (
    <>
      <IconButton icon="folder-open" size="small" action="coverage.importReport" />
      <IconButton icon="list" size="small" action="coverage.manageReports" />
      <IconButton
        icon={visible ? "close" : "eye"}
        size="small"
        title={visible ? "Hide Coverage" : "Show Coverage"}
        disabled={!hasSuite}
        onClick={() => setCoverageVisible(!visible)}
      />
    </>
  );
}

function Metric({ covered, total, compact }: { covered: number; total: number; compact: boolean }) {
  const value = formatPercent(covered, total);
  const [percentage, count] = value.split(" ", 2);
  return (
    <span className={styles.value} title={value}>
      {percentage}
      {count && <span className={compact ? styles.compactCount : undefined}> {count}</span>}
    </span>
  );
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "name", label: "Element" },
  { key: "lines", label: "Line, %" },
  { key: "branches", label: "Branch, %" },
];

export function CoverageView() {
  const tx = useTx();
  const suite = useCoverage((s) => activeSuite(s));
  const visible = useCoverage((s) => s.visible);
  const root = useProject((s) => s.project?.root ?? "");
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: "name", ascending: true });
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [preferred, setPreferred] = useState(readCoverageWidths);
  useEffect(() => {
    if (!pane) return;
    const observer = new ResizeObserver(() => setPaneWidth(pane.clientWidth));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);
  useEffect(() => saveCoverageWidths(preferred), [preferred]);

  const roots = useMemo(
    () => (suite ? sortTree(coverageTree(suite.data, root), sort.key, sort.ascending) : []),
    [suite, root, sort],
  );
  const effectiveExpanded = useMemo(
    () => expanded ?? new Set(roots.filter((n) => n.dir).map((n) => n.path)),
    [expanded, roots],
  );

  if (!suite) {
    return (
      <EmptyState title="No coverage data">
        <span>
          <T>Run a configuration with coverage to see which lines its tests execute.</T>
        </span>
        <span className={styles.links}>
          <button type="button" className={styles.link} onClick={() => void executeAction("run.coverage")}>
            <T>Run with Coverage</T>
          </button>
          <button type="button" className={styles.link} onClick={() => void executeAction("coverage.importReport")}>
            <T>Import a report collected in CI from disk</T>
          </button>
        </span>
      </EmptyState>
    );
  }
  const branches = suite.data.hasBranches;
  const columns = branches ? COLUMNS : COLUMNS.slice(0, 2);
  const { min, budget, widths } = coverageColumns(paneWidth, branches, preferred);
  const statsWidth = widths.lines + widths.branches;
  const columnStyle = {
    "--coverage-lines-width": `${widths.lines}px`,
    "--coverage-branches-width": `${widths.branches}px`,
    "--coverage-stats-width": `${statsWidth}px`,
  } as CSSProperties;
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, ascending: !s.ascending } : { key, ascending: key === "name" }));
  const resizeLines = (lines: number) =>
    setPreferred((old) => ({ ...old, lines, ...(branches && { branches: widths.branches }) }));
  const resizeBranches = (width: number) => setPreferred({ lines: statsWidth - width, branches: width });

  return (
    <div ref={setPane} className={clsx(styles.view, !branches && styles.noBranches)} style={columnStyle}>
      {!visible && (
        <div className={styles.banner}>
          <T>Coverage is hidden in editors and the project view.</T>
        </div>
      )}
      <div className={styles.header} role="row">
        {columns.map((c) => (
          <div className={styles.heading} key={c.key}>
            <button
              type="button"
              role="columnheader"
              aria-sort={sort.key === c.key ? (sort.ascending ? "ascending" : "descending") : "none"}
              className={styles.headerCell}
              title={tx(c.label)}
              onClick={() => toggleSort(c.key)}
            >
              <span className={styles.label}>{tx(c.label)}</span>
              {sort.key === c.key && <Icon name={sort.ascending ? "chevron-up" : "chevron-down"} size={12} />}
            </button>
            {c.key !== "name" && paneWidth > 0 && (
              <ColumnDivider
                title={c.label}
                width={widths[c.key]}
                min={min}
                max={c.key === "lines" ? budget - widths.branches : statsWidth - min}
                onResize={c.key === "lines" ? resizeLines : resizeBranches}
                onReset={() => setPreferred(branches ? {} : { branches: preferred.branches })}
              />
            )}
          </div>
        ))}
      </div>
      <Tree<CoverageNode>
        aria-label="Coverage"
        className={styles.tree}
        indent={12}
        maxRowInset="var(--coverage-max-row-inset)"
        roots={roots}
        getKey={(n) => n.path}
        getLabel={(n) => n.name}
        getChildren={(n) => (n.dir ? n.children : undefined)}
        isExpandable={(n) => n.dir}
        expanded={effectiveExpanded}
        onExpandedChange={(next) => setExpanded(next)}
        onActivate={(n) => {
          if (!n.dir) void editorService().openFile(n.path);
        }}
        renderNode={(n) => (
          <span className={styles.row}>
            <span className={styles.name}>
              <Icon name={n.dir ? "folder" : fileIconName(n.name)} size={16} className={styles.icon} />
              <span className={styles.label} title={n.name}>
                {n.name}
              </span>
            </span>
            <Metric covered={n.linesCovered} total={n.linesTotal} compact={widths.lines < 92} />
            {branches && <Metric covered={n.branchesCovered} total={n.branchesTotal} compact={widths.branches < 92} />}
          </span>
        )}
        empty={<EmptyState title="The report covers no files" />}
      />
    </div>
  );
}
