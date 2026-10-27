/**
 * Project-wide diagnostics for the Problems tool window, status bar and file
 * decorations. The backend sends full replacements per (file, producer), so
 * the store keeps one list per source and merges them per file.
 */
import { create } from "zustand";
import type { Diagnostic, Severity } from "@/bindings";
import { onIdeEvent } from "@/platform/ipc";
import { onLocalDiagnostics } from "@/platform/localDiagnostics";
import {
  applyProfile,
  inspectionProfile,
  subscribeInspectionProfile,
  type ProfileOverrides,
} from "@/platform/inspections";

export type FileDiagnostics = ReadonlyMap<string, readonly Diagnostic[]>;
/** path → source → diagnostics. */
export type ProblemsMap = ReadonlyMap<string, FileDiagnostics>;

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

/** Replaces `source`'s diagnostics for `path`; returns the same map when nothing changed. */
export function mergeDiagnostics(map: ProblemsMap, path: string, source: string, items: readonly Diagnostic[]): ProblemsMap {
  const prev = map.get(path);
  if (!items.length && !prev?.has(source)) return map;
  const next = new Map(map);
  const sources = new Map(prev ?? []);
  if (items.length) sources.set(source, items.map((d) => (d.source ? d : { ...d, source })));
  else sources.delete(source);
  if (sources.size) next.set(path, sources);
  else next.delete(path);
  return next;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** All diagnostics of a file across sources, ordered by position then severity. */
export function fileDiagnostics(map: ProblemsMap, path: string): Diagnostic[] {
  const sources = map.get(path);
  if (!sources) return [];
  return [...sources.values()]
    .flat()
    .sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.col - b.range.start.col ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
}

/** The producer (inspection) that reported `d`, one of `path`'s problems in `map`. */
export function producerFor(map: ProblemsMap, path: string, d: Diagnostic): string | null {
  for (const [source, items] of map.get(path) ?? []) if (items.includes(d)) return source;
  return null;
}

export interface ProblemOrder {
  /** Errors before warnings before infos (IDEA's default). */
  bySeverity: boolean;
  /** By message text, then position; otherwise by position, then text. */
  byName: boolean;
}

export const DEFAULT_PROBLEM_ORDER: ProblemOrder = { bySeverity: true, byName: false };

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A file's problems in the Problems view order (Sort by Severity / Name). */
export function sortProblems(items: readonly Diagnostic[], order: ProblemOrder): Diagnostic[] {
  const position = (a: Diagnostic, b: Diagnostic) =>
    a.range.start.line - b.range.start.line || a.range.start.col - b.range.start.col;
  return [...items].sort(
    (a, b) =>
      (order.bySeverity ? SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] : 0) ||
      (order.byName
        ? natural.compare(a.message, b.message) || position(a, b)
        : position(a, b) || natural.compare(a.message, b.message)),
  );
}

export function countSeverities(diags: Iterable<Diagnostic>): SeverityCounts {
  const c: SeverityCounts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of diags) c[d.severity]++;
  return c;
}

export function projectCounts(map: ProblemsMap): SeverityCounts {
  const c: SeverityCounts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const sources of map.values()) for (const items of sources.values()) for (const d of items) c[d.severity]++;
  return c;
}

export function worstSeverity(diags: Iterable<Diagnostic>): Severity | null {
  let best: Severity | null = null;
  for (const d of diags) if (best === null || SEVERITY_ORDER[d.severity] < SEVERITY_ORDER[best]) best = d.severity;
  return best;
}

/** `raw` under the inspection profile: disabled inspections dropped, severities remapped. */
export function profiledProblems(raw: ProblemsMap, profile: ProfileOverrides): ProblemsMap {
  let out: ProblemsMap = new Map();
  for (const [path, sources] of raw) {
    for (const [source, items] of sources) {
      out = mergeDiagnostics(out, path, source, applyProfile(profile, source, items));
    }
  }
  return out;
}

interface ProblemsState {
  /** As reported, before the inspection profile. */
  raw: ProblemsMap;
  /** What the views show. */
  map: ProblemsMap;
}

export const useProblems = create<ProblemsState>(() => ({ raw: new Map(), map: new Map() }));

export function applyDiagnosticsEvent(path: string, source: string, items: readonly Diagnostic[]) {
  useProblems.setState((s) => {
    const raw = mergeDiagnostics(s.raw, path, source, items);
    if (raw === s.raw) return s;
    const map = mergeDiagnostics(s.map, path, source, applyProfile(inspectionProfile(), source, items));
    return { raw, map };
  });
}

export function clearProblems() {
  useProblems.setState({ raw: new Map(), map: new Map() });
}

export function installProblemsEvents(): () => void {
  const off = onIdeEvent("diagnostics", (e) => applyDiagnosticsEvent(e.path, e.source, e.items));
  // Typo, file references, SQL: inspections the editor runs itself.
  const offLocal = onLocalDiagnostics(applyDiagnosticsEvent);
  const offProfile = subscribeInspectionProfile(() =>
    useProblems.setState((s) => ({ map: profiledProblems(s.raw, inspectionProfile()) })),
  );
  return () => {
    off();
    offLocal();
    offProfile();
  };
}
