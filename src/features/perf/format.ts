/** IDEA-style compact numbers for the memory indicator and diagnostics. */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** `512B`, `12K`, `412M`, `1.9G`, `2G` (binary units, like IDEA's indicator). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "–";
  if (bytes < KB) return `${Math.round(bytes)}B`;
  if (bytes < MB) return `${Math.round(bytes / KB)}K`;
  // Round first so 1023.6M shows as 1G, not 1024M.
  const m = Math.round(bytes / MB);
  if (m < 1024) return `${m}M`;
  return `${trim(bytes / GB)}G`;
}

/** `560 MB`, `1.1 GB`, `12 KB` (binary units, as Activity Monitor and the Task Manager show them). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "–";
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  const m = Math.round(bytes / MB);
  if (m < 1024) return `${m} MB`;
  return `${trim(bytes / GB)} GB`;
}

/** `0%`, `3.2%`, `45%`, `180%` (percent of one core, so several busy cores exceed 100). */
export function formatPercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p) || p < 0) return "–";
  if (p < 0.05) return "0%";
  return p < 10 ? `${trim(p)}%` : `${Math.round(p)}%`;
}

/** `0.4 ms`, `16 ms`, `2.3 s`. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  if (ms < 10) return `${trim(ms)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${trim(ms / 1000)} s`;
}

/** `42s`, `5m 03s`, `2h 07m`, `3d 4h`. */
export function formatUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** `1,234` style grouping without locale surprises. */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
