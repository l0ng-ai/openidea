/**
 * Coverage suites of this project window: the last few runs stay selectable,
 * one is shown (editor gutter, project tree, Coverage tool window) until hidden.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import type { CoverageSuite, FileCoverage } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";
import { coverageBadges, coverageTree } from "./model";

/** Suites kept (IDEA keeps a list of recent suites to choose from). */
export const MAX_SUITES = 5;

export interface Suite {
  id: string;
  /** Run configuration name, or the imported report's file name. */
  name: string;
  createdAt: number;
  /** The report file of an imported suite ("Import a report collected in CI"). */
  file?: string;
  data: CoverageSuite;
  byPath: Map<string, FileCoverage>;
}

interface CoverageState {
  /** Newest first. */
  suites: Suite[];
  activeId: string | null;
  /** Whether the active suite is shown in editors and the project tree. */
  visible: boolean;
}

export const useCoverage = create<CoverageState>(() => ({ suites: [], activeId: null, visible: false }));

export function captureCoverageProject() {
  const { project, opening } = useProject.getState();
  if (!project || opening) return null;
  const root = project.root;
  return {
    root,
    isCurrent: () => {
      const current = useProject.getState();
      return !current.opening && current.project?.root === root;
    },
  };
}

let seq = 0;

export function activeSuite(s: CoverageState = useCoverage.getState()): Suite | null {
  return s.suites.find((x) => x.id === s.activeId) ?? null;
}

/** The shown coverage of `path`, if any. */
export function shownFileCoverage(path: string, s: CoverageState = useCoverage.getState()): FileCoverage | null {
  if (!s.visible) return null;
  return activeSuite(s)?.byPath.get(path) ?? null;
}

export function addSuite(name: string, data: CoverageSuite, file?: string): Suite {
  const suite: Suite = {
    id: `suite${++seq}`,
    name,
    createdAt: Date.now(),
    file,
    data,
    byPath: new Map(data.files.map((f) => [f.path, f])),
  };
  useCoverage.setState((s) => ({
    // A re-imported file replaces its earlier suite.
    suites: [suite, ...s.suites.filter((x) => !file || x.file !== file)].slice(0, MAX_SUITES),
    activeId: suite.id,
    visible: true,
  }));
  return suite;
}

export function selectSuite(id: string) {
  useCoverage.setState({ activeId: id, visible: true });
}

export function closeSuite(id: string) {
  useCoverage.setState((s) => {
    const suites = s.suites.filter((x) => x.id !== id);
    const activeId = s.activeId === id ? (suites[0]?.id ?? null) : s.activeId;
    return { suites, activeId, visible: s.visible && !!activeId };
  });
}

export function setCoverageVisible(visible: boolean) {
  useCoverage.setState((s) => ({ visible: visible && !!s.activeId }));
}

export function resetCoverage() {
  useCoverage.setState({ suites: [], activeId: null, visible: false });
}

/** Keeps the `coverageVisible` context key and the project tree badges in sync. */
export function syncCoverageViews(): () => void {
  const apply = (s: CoverageState) => {
    setContext("coverageVisible", s.visible);
    setContext("coverageSuites", s.suites.length > 0);
    const suite = s.visible ? activeSuite(s) : null;
    const root = useProject.getState().project?.root;
    const decorations = new Map<string, FileDecoration>();
    if (suite && root) {
      for (const [path, badge] of coverageBadges(coverageTree(suite.data, root, false)))
        decorations.set(path, { badge });
    }
    setFileDecorations("coverage", decorations);
  };
  apply(useCoverage.getState());
  const unsub = useCoverage.subscribe((s, prev) => {
    if (s.visible !== prev.visible || s.activeId !== prev.activeId || s.suites !== prev.suites) apply(s);
  });
  return () => {
    unsub();
    setFileDecorations("coverage", new Map());
  };
}

// ---------------------------------------------------------------------------
// Imported reports, remembered per project so "Manage Coverage Reports" lists
// them after a restart.

export interface ImportedReport {
  path: string;
  name: string;
  importedAt: number;
}

const IMPORTED_KEY = "openidea.coverage.imported.v1:";
const MAX_IMPORTED = 20;

export function importedReports(root: string | null = useProject.getState().project?.root ?? null): ImportedReport[] {
  if (!root) return [];
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(IMPORTED_KEY + root) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is ImportedReport =>
        !!r && typeof r.path === "string" && typeof r.name === "string" && typeof r.importedAt === "number",
    );
  } catch {
    return [];
  }
}

function saveImported(root: string, reports: ImportedReport[]) {
  try {
    globalThis.localStorage?.setItem(IMPORTED_KEY + root, JSON.stringify(reports.slice(0, MAX_IMPORTED)));
  } catch {
    /* storage unavailable */
  }
}

export function rememberImport(root: string, report: ImportedReport) {
  saveImported(root, [report, ...importedReports(root).filter((r) => r.path !== report.path)]);
}

export function forgetImport(path: string) {
  const root = useProject.getState().project?.root;
  if (root)
    saveImported(
      root,
      importedReports(root).filter((r) => r.path !== path),
    );
}

/** A row of "Manage Coverage Reports": a loaded suite, or an imported report not loaded now. */
export interface ReportEntry {
  key: string;
  name: string;
  /** Tool or file shown beside the name. */
  detail: string;
  time: number;
  suite: Suite | null;
  file: string | null;
}

export function reportEntries(suites: readonly Suite[], imported: readonly ImportedReport[]): ReportEntry[] {
  const out: ReportEntry[] = suites.map((s) => ({
    key: s.id,
    name: s.name,
    detail: s.file ?? s.data.runner,
    time: s.createdAt,
    suite: s,
    file: s.file ?? null,
  }));
  for (const r of imported) {
    if (suites.some((s) => s.file === r.path)) continue;
    out.push({ key: `file:${r.path}`, name: r.name, detail: r.path, time: r.importedAt, suite: null, file: r.path });
  }
  return out;
}
