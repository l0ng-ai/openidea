/**
 * Inspection Results tool window: inspection → file → problem (or severity
 * first, on request), with the selected problem's details on the right.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { basename, relativeDir, useProject } from "@/platform/project";
import { editorService, useOccurrenceNavigator } from "@/workbench/contributions";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  ProgressBar,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
  type TreeRowState,
  T,
  selectableText,
} from "@/ui";
import {
  cancelInspection,
  groupInspection,
  problemId,
  rerunInspection,
  severityKey,
  toggleExcludedProblems,
  useInspection,
  type InspectionKindGroup,
  type InspectionProblem,
  type SeverityKey,
} from "./inspect";
import styles from "./Analysis.module.css";

type Node =
  | { kind: "severity"; key: string; severity: SeverityKey; count: number; children: Node[] }
  | { kind: "inspection"; key: string; name: string; severity: SeverityKey; count: number; children: Node[] }
  | { kind: "file"; key: string; path: string; count: number; children: Node[] }
  | { kind: "problem"; key: string; p: InspectionProblem };

const SEVERITY_LABEL: Record<SeverityKey, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Weak warnings and hints",
};

// ---------------------------------------------------------------------------
// View options (persisted), in the tool window's ⋮ menu. IDEA's defaults:
// grouped by inspection, no autoscroll.

const OPTIONS_KEY = "openidea.inspection.view.v1";

interface InspectionOptions {
  groupBySeverity: boolean;
  autoscroll: boolean;
}

function loadOptions(): Partial<InspectionOptions> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") as Partial<InspectionOptions>;
  } catch {
    return {};
  }
}

export const useInspectionOptions = create<InspectionOptions>(() => ({
  groupBySeverity: false,
  autoscroll: false,
  ...loadOptions(),
}));

useInspectionOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

/** The Inspection Results tool window's ⋮ menu entries. */
export function useInspectionHeaderMenu(): MenuItem[] {
  const o = useInspectionOptions();
  return [
    {
      id: "groupBySeverity",
      label: "Group by Severity",
      checked: o.groupBySeverity,
      run: () => useInspectionOptions.setState({ groupBySeverity: !o.groupBySeverity }),
    },
    {
      id: "autoscroll",
      label: "Autoscroll to Source",
      checked: o.autoscroll,
      run: () => useInspectionOptions.setState({ autoscroll: !o.autoscroll }),
    },
  ];
}

const SEVERITY_RANK: Record<SeverityKey, number> = { error: 0, warning: 1, info: 2 };

/** Inspections across severities, merged by name (the same check may report errors and warnings). */
function mergeKinds(
  groups: ReturnType<typeof groupInspection>,
): Array<InspectionKindGroup & { severity: SeverityKey }> {
  const byKind = new Map<string, InspectionKindGroup & { severity: SeverityKey }>();
  for (const g of groups) {
    for (const k of g.kinds) {
      const prev = byKind.get(k.kind);
      if (!prev) {
        byKind.set(k.kind, {
          ...k,
          files: k.files.map((f) => ({ ...f, problems: [...f.problems] })),
          severity: g.severity,
        });
        continue;
      }
      prev.count += k.count;
      for (const f of k.files) {
        const same = prev.files.find((x) => x.path === f.path);
        if (same) same.problems.push(...f.problems);
        else prev.files.push({ ...f, problems: [...f.problems] });
      }
    }
  }
  const pos = (p: InspectionProblem) => p.d.range.start.line * 1e6 + p.d.range.start.col;
  return [...byKind.values()]
    .map((k) => {
      k.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
      k.files.forEach((f) => f.problems.sort((a, b) => pos(a) - pos(b)));
      return k;
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.kind.localeCompare(b.kind));
}

function kindNode(k: InspectionKindGroup, severity: SeverityKey, prefix: string): Node {
  const kindKey = `${prefix}\u0000${k.kind}`;
  return {
    kind: "inspection",
    key: kindKey,
    name: k.kind,
    severity,
    count: k.count,
    children: k.files.map((f) => {
      const fileKey = `${kindKey}\u0000${f.path}`;
      return {
        kind: "file",
        key: fileKey,
        path: f.path,
        count: f.problems.length,
        children: f.problems.map((p, i) => ({ kind: "problem", key: `${fileKey}\u0000${i}`, p }) as Node),
      } as Node;
    }),
  };
}

/** Result tree: inspection → file → problem, under severity groups with `bySeverity`. */
export function buildInspectionNodes(groups: ReturnType<typeof groupInspection>, bySeverity = true): Node[] {
  if (!bySeverity) return mergeKinds(groups).map((k) => kindNode(k, k.severity, "kind"));
  return groups.map((s) => ({
    kind: "severity",
    key: s.severity,
    severity: s.severity,
    count: s.count,
    children: s.kinds.map((k) => kindNode(k, s.severity, s.severity)),
  }));
}

function nodeProblems(n: Node): InspectionProblem[] {
  return n.kind === "problem" ? [n.p] : n.children.flatMap(nodeProblems);
}

function open(p: InspectionProblem, focus = true): Promise<void> {
  return editorService().openFile(p.path, {
    selection: { line: p.d.range.start.line, col: p.d.range.start.col },
    focus,
    preview: !focus,
  });
}

/** Jump to the problem and show the editor's quick fixes there. */
async function showFixes(p: InspectionProblem) {
  await open(p, true);
  void executeAction("code.showIntentions");
}

export function InspectionHeaderActions() {
  const running = useInspection((s) => s.running);
  const last = useInspection((s) => s.last);
  return (
    <>
      <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" />
      <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" />
      <IconButton
        icon="rerun"
        title="Rerun Inspection"
        size="small"
        disabled={!last || running}
        onClick={rerunInspection}
      />
      <IconButton icon="stop" title="Stop" size="small" disabled={!running} onClick={cancelInspection} />
    </>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function InspectionView() {
  const { files, running, total, done, summary, scopeLabel, error, excluded } = useInspection();
  const bySeverity = useInspectionOptions((o) => o.groupBySeverity);
  const root = useProject((s) => s.project?.root ?? "");
  const roots = useMemo(() => buildInspectionNodes(groupInspection(files.values()), bySeverity), [files, bySeverity]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [lead, setLead] = useState<Node | null>(null);
  const tree = useRef<TreeHandle>(null);
  // Groups start expanded; files too unless there are many problems.
  const expanded = useMemo(() => {
    const out = new Set<string>();
    const total = roots.reduce((n, r) => n + (r.kind === "problem" ? 0 : r.count), 0);
    const depthOpen = (total <= 200 ? 3 : 2) - (bySeverity ? 0 : 1);
    const visit = (nodes: Node[], depth: number) => {
      for (const n of nodes) {
        if (n.kind === "problem") continue;
        if (!collapsed.has(n.key) && depth < depthOpen) out.add(n.key);
        visit(n.children, depth + 1);
      }
    };
    visit(roots, 0);
    return out;
  }, [roots, collapsed, bySeverity]);

  const getChildren = useCallback((n: Node) => (n.kind === "problem" ? undefined : n.children), []);
  const isExcluded = (n: Node) => nodeProblems(n).every((p) => excluded.has(problemId(p)));

  useOccurrenceNavigator("inspection", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "problem") return null;
    void open(n.p, focus);
    return step;
  });

  const exclude = (n: Node | null) => {
    if (!n) return;
    const problems = nodeProblems(n);
    const wasExcluded = isExcluded(n);
    toggleExcludedProblems(problems);
    // Excluding moves on to the next problem, as in IDEA.
    if (!wasExcluded) tree.current?.selectOccurrence(1, { skipSubtree: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      exclude(lead);
    }
  };

  const renderNode = (n: Node, state: TreeRowState) => {
    const off = isExcluded(n) && styles.excluded;
    switch (n.kind) {
      case "severity":
        return (
          <span className={clsx(styles.row, off)}>
            <Icon name={n.severity} size={14} className={styles[`sev-${n.severity}`]} />
            <span className={styles.strong}>{SEVERITY_LABEL[n.severity]}</span>
            <span className={styles.count}>{plural(n.count, "problem")}</span>
          </span>
        );
      case "inspection":
        return (
          <span className={clsx(styles.row, off)}>
            {!bySeverity && <Icon name={n.severity} size={14} className={styles[`sev-${n.severity}`]} />}
            <span className={styles.strong}>{n.name}</span>
            <span className={styles.count}>{n.count}</span>
          </span>
        );
      case "file":
        return (
          <span className={clsx(styles.row, off)}>
            <Icon name={fileIconName(basename(n.path))} size={16} className={styles.fileIcon} />
            <span className={state.selected ? styles.strong : undefined}>{basename(n.path)}</span>
            <span className={styles.muted}>{relativeDir(root, n.path)}</span>
            <span className={styles.count}>{n.count}</span>
          </span>
        );
      case "problem":
        return (
          <span className={clsx(styles.row, off)} title={n.p.d.message}>
            <span className={styles.message}>{n.p.d.message.split("\n")[0]}</span>
            <span className={styles.muted}>:{n.p.d.range.start.line + 1}</span>
          </span>
        );
    }
  };

  const status = running
    ? `Inspecting ${scopeLabel ?? ""}… ${done}/${total || "?"} files`
    : summary
      ? `${scopeLabel}: ${plural(summary.problems, "problem")} in ${plural(summary.files, "file")}` +
        (summary.skipped ? `, ${summary.skipped} without a language server` : "") +
        (summary.failed ? `, ${summary.failed} failed` : "") +
        (summary.cancelled ? " (stopped)" : "") +
        (excluded.size ? `, ${excluded.size} excluded` : "")
      : null;

  return (
    <div className={styles.view}>
      {status && (
        <div className={styles.status} role="status">
          <span className={styles.statusText}>{status}</span>
          {running && (
            <ProgressBar
              value={total ? done / total : null}
              className={styles.progress}
              aria-label="Inspection progress"
            />
          )}
        </div>
      )}
      <div className={styles.body} onKeyDown={onKeyDown}>
        <SplitGroup orientation="horizontal" id="inspection-details-split">
          <SplitPanel id="results" minSize={160} className={styles.panel}>
            <Tree<Node>
              aria-label="Inspection results"
              handleRef={tree}
              roots={roots}
              getKey={(n) => n.key}
              getLabel={(n) =>
                n.kind === "severity"
                  ? SEVERITY_LABEL[n.severity]
                  : n.kind === "inspection"
                    ? n.name
                    : n.kind === "file"
                      ? basename(n.path)
                      : n.p.d.message
              }
              getChildren={getChildren}
              isExpandable={(n) => n.kind !== "problem"}
              isOccurrence={(n) => n.kind === "problem" && !excluded.has(problemId(n.p))}
              expanded={expanded}
              onExpandedChange={(_next, node, isOpen) =>
                setCollapsed((prev) => {
                  const s = new Set(prev);
                  if (isOpen) s.delete(node.key);
                  else s.add(node.key);
                  return s;
                })
              }
              renderNode={renderNode}
              onActivate={(n) => {
                if (n.kind === "problem") void open(n.p);
              }}
              onSelectionChange={(_sel, node) => {
                setLead(node);
                // Autoscroll to Source (off by default, as in IDEA).
                if (node?.kind === "problem" && useInspectionOptions.getState().autoscroll) void open(node.p, false);
              }}
              onContextMenu={(n, _sel, e) => {
                if (!n) return;
                showContextMenu(e, [
                  ...(n.kind === "problem"
                    ? [
                        { id: "jump", label: "Jump to Source", shortcut: "F4", run: () => void open(n.p) },
                        {
                          id: "fixes",
                          label: "Show Quick Fixes",
                          icon: "bulb",
                          shortcut: shortcutLabel("code.showIntentions") ?? undefined,
                          run: () => void showFixes(n.p),
                        },
                        { kind: "separator" as const },
                      ]
                    : []),
                  { id: "exclude", label: isExcluded(n) ? "Include" : "Exclude", shortcut: "⌫", run: () => exclude(n) },
                ]);
              }}
              activateExpandable={false}
              multiSelect={false}
              empty={
                error ? (
                  <EmptyState icon="error" title={error} />
                ) : running ? (
                  <EmptyState icon="problems" title="Inspecting…" />
                ) : summary ? (
                  <EmptyState icon="check" title="No problems found" />
                ) : (
                  <EmptyState icon="problems" title="Run Code › Inspect Code… to analyse files" />
                )
              }
            />
          </SplitPanel>
          {roots.length > 0 && (
            <>
              <SplitHandle />
              <SplitPanel id="details" minSize={160} defaultSize="40%" className={styles.panel}>
                <ProblemDetails node={lead} root={root} />
              </SplitPanel>
            </>
          )}
        </SplitGroup>
      </div>
    </div>
  );
}

/** Right pane: the selected problem (or group) in full, with its actions. */
function ProblemDetails({ node, root }: { node: Node | null; root: string }) {
  if (!node || node.kind === "severity" || node.kind === "file") {
    const count = node ? nodeProblems(node).length : 0;
    return (
      <div className={clsx(styles.details, styles.detailsEmpty)}>
        {node ? plural(count, "problem") : <T>Select a problem to see its details</T>}
      </div>
    );
  }
  if (node.kind === "inspection") {
    return (
      <div className={styles.details}>
        <div className={styles.detailsTitle}>{node.name}</div>
        <div className={styles.muted}>
          {SEVERITY_LABEL[node.severity]} · {plural(node.count, "problem")}
        </div>
      </div>
    );
  }
  const { p } = node;
  const sev = severityKey(p.d);
  return (
    <div className={styles.details}>
      <div className={styles.detailsTitle}>
        <Icon name={sev} size={14} className={styles[`sev-${sev}`]} />
        <span>{p.d.source ? `${p.d.source}${p.d.code ? ` (${p.d.code})` : ""}` : <T>Language server</T>}</span>
      </div>
      <p className={clsx(styles.detailsMessage, selectableText)}>{p.d.message}</p>
      <div className={styles.muted}>
        {relativeDir(root, p.path) ? `${relativeDir(root, p.path)}/` : ""}
        {basename(p.path)}:{p.d.range.start.line + 1}:{p.d.range.start.col + 1}
      </div>
      <div className={styles.detailsActions}>
        <Button size="small" icon="bulb" onClick={() => void showFixes(p)}>
          <T>Show Quick Fixes</T>
        </Button>
        <Button size="small" variant="ghost" onClick={() => void open(p)}>
          <T>Jump to Source</T>
        </Button>
      </div>
    </div>
  );
}
