/** Memory breakdown from `AppMetrics.memory`: totals per group and the popup sections. */
import type { AppMetrics, MemoryCategory, ProcessMemory } from "@/platform/ipc";
import { formatBytes, formatPercent, formatSize } from "./format";

export interface MemorySummary {
  /** Backend + its WebView processes. */
  app: number | null;
  languageServers: number | null;
  processes: number | null;
  total: number | null;
}

function sum(rows: ProcessMemory[]): number | null {
  const known = rows.filter((r) => r.bytes != null);
  return known.length ? known.reduce((n, r) => n + r.bytes!, 0) : null;
}

const byCategory = (rows: ProcessMemory[], c: MemoryCategory) => rows.filter((r) => r.category === c);

export function summarizeMemory(m: Pick<AppMetrics, "memory" | "rssBytes"> | null): MemorySummary {
  const rows = m?.memory ?? [];
  const app = sum(byCategory(rows, "app")) ?? m?.rssBytes ?? null;
  const languageServers = sum(byCategory(rows, "languageServer"));
  const processes = sum(byCategory(rows, "process"));
  const parts = [app, languageServers, processes].filter((n): n is number => n != null);
  return { app, languageServers, processes, total: parts.length ? parts.reduce((a, b) => a + b, 0) : null };
}

/** Status bar text: `OpenIDEA 560M` (no denominator: there is no heap limit to compare with). */
export function indicatorLabel(s: MemorySummary): string {
  return s.app == null ? "OpenIDEA –" : `OpenIDEA ${formatBytes(s.app)}`;
}

/** Status bar tooltip: `OpenIDEA 560 MB · language servers 1.1 GB · processes 80 MB`. */
export function indicatorTooltip(s: MemorySummary): string {
  const parts = [`OpenIDEA ${formatSize(s.app)}`];
  if (s.languageServers != null) parts.push(`language servers ${formatSize(s.languageServers)}`);
  if (s.processes != null) parts.push(`processes ${formatSize(s.processes)}`);
  return parts.join(" · ");
}

export interface BreakdownRow {
  key: string;
  label: string;
  /** Project, windows, run kind… */
  detail: string | null;
  value: string;
  cpu: string;
  pid: number;
  processes: number;
  /** A language server, run, terminal or other child the user may end (never OpenIDEA's own processes). */
  endable: boolean;
}

export interface BreakdownSection {
  title: string;
  total: string;
  cpu: string;
  rows: BreakdownRow[];
}

function cpuSum(rows: ProcessMemory[]): number | null {
  const known = rows.filter((r) => r.cpuPercent != null);
  return known.length ? known.reduce((n, r) => n + r.cpuPercent!, 0) : null;
}

const SECTIONS: Array<{ category: MemoryCategory; title: string }> = [
  { category: "app", title: "OpenIDEA" },
  { category: "languageServer", title: "Language servers" },
  { category: "process", title: "Debug adapters & processes" },
];

/** Popup sections, one per non-empty category, rows in backend order. */
export function memorySections(rows: ProcessMemory[]): BreakdownSection[] {
  return SECTIONS.flatMap(({ category, title }) => {
    const items = byCategory(rows, category);
    if (!items.length) return [];
    return [
      {
        title,
        total: formatSize(sum(items)),
        cpu: formatPercent(cpuSum(items)),
        rows: items.map((r, i) => ({
          key: `${category}:${i}:${r.label}`,
          label: r.label,
          detail: r.detail,
          value: formatSize(r.bytes),
          cpu: formatPercent(r.cpuPercent),
          pid: r.pid,
          processes: r.processes,
          endable: category !== "app",
        })),
      },
    ];
  });
}
