/** Problems tool window: "File" (current editor) and "Project Errors" tabs. */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import type { Diagnostic, Severity } from "@/bindings";
import { useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { formatBinding, hasPrimaryModifier, hostBinding, shortcutLabel } from "@/platform/keymap";
import { basename, relativeDir, useProject } from "@/platform/project";
import { diagnosticInspection, producerOf, type InspectionRef } from "@/platform/inspections";
import { problemControls } from "@/platform/inspectionControls";
import { editorService, useOccurrenceNavigator } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  SourcePreview,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import { previewText } from "./ipc";
import {
  DEFAULT_PROBLEM_ORDER,
  countSeverities,
  fileDiagnostics,
  producerFor,
  sortProblems,
  useProblems,
  type ProblemOrder,
  type ProblemsMap,
} from "./problemsStore";
import styles from "./ProblemsView.module.css";

type Tab = "file" | "project";

interface ViewState {
  tab: Tab;
  show: Record<"error" | "warning" | "info", boolean>;
  setTab(tab: Tab): void;
  toggle(sev: "error" | "warning" | "info"): void;
}

export const useProblemsView = create<ViewState>((set) => ({
  tab: "file",
  show: { error: true, warning: true, info: true },
  setTab: (tab) => set({ tab }),
  toggle: (sev) => set((s) => ({ show: { ...s.show, [sev]: !s.show[sev] } })),
}));

// ---------------------------------------------------------------------------
// View options (persisted), in the tool window's ⋮ menu. IDEA's defaults:
// no autoscroll, no preview, sorted by severity.

const OPTIONS_KEY = "openidea.problems.view.v1";

interface ProblemsOptions extends ProblemOrder {
  /** Selecting a problem opens it in the editor. */
  autoscroll: boolean;
  /** Source preview beside the list. */
  preview: boolean;
}

function loadOptions(): Partial<ProblemsOptions> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") as Partial<ProblemsOptions>;
  } catch {
    return {};
  }
}

export const useProblemsOptions = create<ProblemsOptions>(() => ({
  autoscroll: false,
  preview: false,
  ...DEFAULT_PROBLEM_ORDER,
  ...loadOptions(),
}));

useProblemsOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

/** The Problems tool window's ⋮ menu entries. */
export function useProblemsHeaderMenu(): MenuItem[] {
  const o = useProblemsOptions();
  const toggle = (key: keyof ProblemsOptions) => () => useProblemsOptions.setState({ [key]: !o[key] });
  return [
    { kind: "header", label: "Sort By" },
    { id: "bySeverity", label: "Severity", checked: o.bySeverity, run: toggle("bySeverity") },
    { id: "byName", label: "Name", checked: o.byName, run: toggle("byName") },
    { kind: "separator" },
    { id: "preview", label: "Show Preview", checked: o.preview, run: toggle("preview") },
    { id: "autoscroll", label: "Autoscroll to Source", checked: o.autoscroll, run: toggle("autoscroll") },
  ];
}

const group = (s: Severity): "error" | "warning" | "info" => (s === "hint" ? "info" : s);

type Node =
  | { kind: "file"; key: string; path: string; items: Diagnostic[] }
  | { kind: "diag"; key: string; path: string; d: Diagnostic };

/** The inspection that reported `d` (for Disable inspection / Change Severity). */
export function diagInspection(map: ProblemsMap, path: string, d: Diagnostic): InspectionRef | null {
  return diagnosticInspection(producerFor(map, path, d) ?? producerOf(d), d);
}

const inspectionMenu = (inspection: InspectionRef | null): MenuItem[] =>
  inspection ? [{ kind: "separator" }, ...problemControls(inspection)] : [];

const plural = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : "");

const SEVERITY_ICON: Record<Severity, string> = { error: "error", warning: "warning", info: "info", hint: "info" };

export function buildProblemNodes(
  map: ProblemsMap,
  paths: readonly string[],
  show: ViewState["show"],
  order: ProblemOrder = DEFAULT_PROBLEM_ORDER,
): Node[] {
  const files: Node[] = [];
  for (const path of paths) {
    const items = sortProblems(
      fileDiagnostics(map, path).filter((d) => show[group(d.severity)]),
      order,
    );
    if (!items.length) continue;
    files.push({ kind: "file", key: path, path, items });
  }
  const rank = (n: Node) => (n.kind === "file" ? (n.items.some((d) => d.severity === "error") ? 0 : 1) : 2);
  return files.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function open(path: string, d: Diagnostic, focus = true): Promise<void> {
  return editorService().openFile(path, {
    selection: { line: d.range.start.line, col: d.range.start.col },
    focus,
    preview: !focus,
  });
}

const problemText = (d: Diagnostic) => `${d.message}${d.source ? ` (${d.source}${d.code ? `(${d.code})` : ""})` : ""}`;

/** ⌥⏎ on a problem: jump to it and show its quick fixes (the editor's context actions). */
async function showQuickFixes(path: string, d: Diagnostic) {
  await open(path, d, true);
  void executeAction("code.showIntentions");
}

function useCurrentPath(): string | null {
  return useEditorRegistry((s) => s.active?.ctx.path ?? null);
}

export function ProblemsHeaderActions() {
  const show = useProblemsView((s) => s.show);
  const toggle = useProblemsView((s) => s.toggle);
  return (
    <>
      <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" />
      <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" />
      <IconButton icon="error" title="Show Errors" size="small" pressed={show.error} onClick={() => toggle("error")} />
      <IconButton
        icon="warning"
        title="Show Warnings"
        size="small"
        pressed={show.warning}
        onClick={() => toggle("warning")}
      />
      <IconButton
        icon="info"
        title="Show Infos and Hints"
        size="small"
        pressed={show.info}
        onClick={() => toggle("info")}
      />
    </>
  );
}

/** Scope tabs in the tool window header: "File: name  2" / "Project Errors". */
export function ProblemsTabs() {
  const map = useProblems((s) => s.map);
  const tab = useProblemsView((s) => s.tab);
  const setTab = useProblemsView((s) => s.setTab);
  const current = useCurrentPath();
  const fileCount = current ? countSeverities(fileDiagnostics(map, current)) : null;
  const projectErrors = useMemo(() => {
    let n = 0;
    for (const sources of map.values())
      for (const items of sources.values()) n += items.filter((d) => d.severity === "error").length;
    return n;
  }, [map]);
  return (
    <Tabs
      variant="compact"
      aria-label="Problems scope"
      className={styles.tabs}
      activeId={tab}
      onSelect={(id) => setTab(id as Tab)}
      items={[
        {
          id: "file",
          label: current ? (
            <>
              <T>File</T> <span className={styles.tabFile}>{basename(current)}</span>
            </>
          ) : (
            "File"
          ),
          text: "File",
          trailing:
            fileCount && fileCount.error + fileCount.warning > 0 ? (
              <span className={styles.tabCount}>{fileCount.error + fileCount.warning}</span>
            ) : undefined,
        },
        {
          id: "project",
          label: "Project Errors",
          trailing: projectErrors ? <span className={styles.tabCount}>{projectErrors}</span> : undefined,
        },
      ]}
    />
  );
}

export function ProblemsView() {
  const map = useProblems((s) => s.map);
  const { tab, show } = useProblemsView();
  const options = useProblemsOptions();
  const current = useCurrentPath();
  const root = useProject((s) => s.project?.root ?? "");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [lead, setLead] = useState<Node | null>(null);
  const tree = useRef<TreeHandle>(null);
  const order = useMemo(
    () => ({ bySeverity: options.bySeverity, byName: options.byName }),
    [options.bySeverity, options.byName],
  );

  const roots = useMemo(() => {
    const paths = tab === "file" ? (current ? [current] : []) : [...map.keys()];
    return buildProblemNodes(map, paths, show, order);
  }, [map, tab, current, show, order]);

  useOccurrenceNavigator("problems", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "diag") return null;
    void open(n.path, n.d, focus);
    return step;
  });

  const target = (n: Node | null) =>
    n?.kind === "diag" ? { path: n.path, d: n.d } : n?.items[0] ? { path: n.path, d: n.items[0] } : null;
  const copy = (n: Node | null) => {
    if (n?.kind === "diag") void navigator.clipboard?.writeText(problemText(n.d));
  };
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = target(lead);
    if (e.key === "Enter" && e.altKey && !e.metaKey && !e.ctrlKey && t) {
      e.preventDefault();
      e.stopPropagation();
      void showQuickFixes(t.path, t.d);
    } else if ((e.key === "c" || e.key === "C") && hasPrimaryModifier(e) && !e.altKey && lead?.kind === "diag") {
      e.preventDefault();
      e.stopPropagation();
      copy(lead);
    }
  };

  const expanded = useMemo(
    () => new Set(roots.filter((r) => !collapsed.has(r.key)).map((r) => r.key)),
    [roots, collapsed],
  );

  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "file"
        ? n.items.map((d, i) => ({ kind: "diag", key: `${n.path}\u0000${i}`, path: n.path, d }) as Node)
        : undefined,
    [],
  );

  const renderNode = (n: Node, state: TreeRowState) => {
    if (n.kind === "file") {
      const c = countSeverities(n.items);
      const parts = [plural(c.error, "error"), plural(c.warning, "warning"), plural(c.info + c.hint, "info")].filter(
        Boolean,
      );
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(basename(n.path))} size={16} className={styles.fileIcon} />
          <span
            className={clsx(styles.fileName, c.error > 0 && styles.fileError, state.selected && styles.selectedText)}
          >
            {basename(n.path)}
          </span>
          <span className={styles.muted}>{relativeDir(root, n.path)}</span>
          <span className={styles.count}>{parts.join(", ")}</span>
        </span>
      );
    }
    const d = n.d;
    return (
      <span className={styles.row} title={d.message}>
        <Icon name={SEVERITY_ICON[d.severity]} size={14} className={styles[`sev-${d.severity}`]} />
        <span className={clsx(styles.message, d.deprecated && styles.deprecated)}>{d.message.split("\n")[0]}</span>
        <span className={styles.position}>:{d.range.start.line + 1}</span>
        {d.source && (
          <span className={styles.source}>
            {d.source}
            {d.code ? `(${d.code})` : ""}
          </span>
        )}
      </span>
    );
  };

  const empty =
    tab === "file" && !current ? (
      <EmptyState icon="problems" title="No file is open" />
    ) : (
      <EmptyState icon="check" title={tab === "file" ? "No problems in this file" : "No problems found"} />
    );

  const selected = target(lead);
  const list = (
    <Tree<Node>
      aria-label="Problems"
      handleRef={tree}
      roots={roots}
      getKey={(n) => n.key}
      getLabel={(n) => (n.kind === "file" ? basename(n.path) : n.d.message)}
      getChildren={getChildren}
      isExpandable={(n) => n.kind === "file"}
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
        if (n.kind === "diag") void open(n.path, n.d);
        else if (n.items[0]) void open(n.path, n.items[0]);
      }}
      onSelectionChange={(_sel, node) => {
        setLead(node);
        // Autoscroll to Source (off by default, as in IDEA): show the problem without leaving the list.
        if (node?.kind === "diag" && useProblemsOptions.getState().autoscroll) void open(node.path, node.d, false);
      }}
      onContextMenu={(n, _sel, e) => {
        const t = target(n);
        if (!n || !t) return;
        showContextMenu(e, [
          {
            id: "showFixes",
            label: "Show Quick Fixes",
            icon: "bulb",
            shortcut: shortcutLabel("code.showIntentions") ?? undefined,
            run: () => void showQuickFixes(t.path, t.d),
          },
          { id: "jump", label: "Jump to Source", shortcut: "F4", run: () => void open(t.path, t.d) },
          { kind: "separator" },
          {
            id: "copy",
            label: "Copy Problem Description",
            icon: "copy",
            shortcut: formatBinding(hostBinding("Meta+C")),
            disabled: n.kind !== "diag",
            run: () => copy(n),
          },
          ...inspectionMenu(n.kind === "diag" ? diagInspection(map, n.path, n.d) : null),
        ]);
      }}
      activateExpandable={false}
      multiSelect={false}
      empty={empty}
    />
  );

  return (
    <div className={styles.view}>
      <div className={styles.body} onKeyDownCapture={onKeyDownCapture}>
        {options.preview ? (
          <SplitGroup orientation="horizontal" id="problems-preview-split">
            <SplitPanel id="problems" minSize={120} className={styles.panel}>
              {list}
            </SplitPanel>
            <SplitHandle />
            <SplitPanel id="preview" minSize={120} defaultSize="50%" className={styles.panel}>
              <SourcePreview
                path={selected?.path ?? null}
                line={selected?.d.range.start.line ?? 0}
                highlights={selected ? [diagHighlight(selected.d)] : []}
                load={previewText}
              />
            </SplitPanel>
          </SplitGroup>
        ) : (
          list
        )}
      </div>
    </div>
  );
}

/** The problem's range on its first line. */
function diagHighlight(d: Diagnostic) {
  const { start, end } = d.range;
  const to = end.line === start.line ? end.col : Number.MAX_SAFE_INTEGER;
  return { line: start.line, ranges: [[start.col, Math.max(start.col + 1, to)] as const] };
}
