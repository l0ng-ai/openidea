/**
 * Remote Host Resources store, polling, pressure thresholds and sparkline geometry.
 *
 * Background polling while the status bar pill is at rest asks `host_metrics(false)`
 * (O(1) kernel counters, no process scan) so the 60s sparklines stay warm at
 * negligible cost; opening the dashboard upgrades polling to `host_metrics(true)`
 * to attribute OpenIDEA's remote processes and top external host processes.
 */
import { create } from "zustand";
import { call, commands, isTauri, type HostMetrics, type RemoteSession } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { formatBytes, formatMs, formatPercent, formatSize } from "@/features/perf/format";

export const REMOTE_METRICS_POLL_MS = 3000;
export const REMOTE_DASHBOARD_POLL_MS = 2000;
export const MAX_RESOURCE_SAMPLES = 30;

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export const CPU_WARN_PERCENT = 85;
export const CPU_DANGER_PERCENT = 95;
export const MEM_WARN_PERCENT = 85;
export const MEM_DANGER_PERCENT = 92;
export const DISK_WARN_PERCENT = 88;
export const DISK_DANGER_PERCENT = 95;
export const DISK_WARN_FREE_BYTES = 3 * GB;
export const DISK_DANGER_FREE_BYTES = 1 * GB;
export const RTT_WARN_MS = 250;
export const RTT_DANGER_MS = 500;
export const NET_SATURATED_BPS = 25 * MB;
export const DISK_IO_SATURATED_BPS = 50 * MB;

export type PressureLevel = "normal" | "warn" | "danger";

export interface ResourceSample {
  cpuPercent: number | null;
  memoryPercent: number | null;
  netBytesPerSec: number | null;
  diskBytesPerSec: number | null;
  rttMs: number | null;
}

export interface ResourcePressure {
  level: PressureLevel;
  cpuLevel: PressureLevel;
  memoryLevel: PressureLevel;
  diskLevel: PressureLevel;
  rttLevel: PressureLevel;
  /** Show network indicator in the compact pill when throughput or RTT is elevated. */
  netSaturated: boolean;
  /** Show disk indicator in the compact pill when disk I/O or capacity is elevated. */
  diskSaturated: boolean;
}

export interface RemoteResourcesState {
  metrics: HostMetrics | null;
  rttMs: number | null;
  history: ResourceSample[];
  popupOpen: boolean;
  error: string | null;
}

const INITIAL_STATE: RemoteResourcesState = {
  metrics: null,
  rttMs: null,
  history: [],
  popupOpen: false,
  error: null,
};

export const useRemoteResources = create<RemoteResourcesState>(() => ({ ...INITIAL_STATE }));

export function canMonitorRemoteHost(session: Pick<RemoteSession, "commands"> | null | undefined): boolean {
  return Boolean(session?.commands.includes("host_metrics"));
}

function sessionIdentity(session: RemoteSession | null): string | null {
  if (!session || !canMonitorRemoteHost(session)) return null;
  return `${JSON.stringify(session.target)}:${session.host}:${session.root}`;
}

let sessionEpoch = 0;
let activeIdentity: string | null = sessionIdentity(useRemote.getState().session);
let inFlightLight = false;
let inFlightDetailed = false;

/** Resets state and invalidates in-flight RPCs whenever the window switches or leaves a remote host. */
export function syncRemoteResourcesSession(session: RemoteSession | null = useRemote.getState().session): void {
  const next = sessionIdentity(session);
  if (next === activeIdentity) return;
  activeIdentity = next;
  sessionEpoch += 1;
  inFlightLight = false;
  inFlightDetailed = false;
  useRemoteResources.setState({ ...INITIAL_STATE });
}

useRemote.subscribe((state) => syncRemoteResourcesSession(state.session));

export function memoryPercent(
  m: Pick<HostMetrics, "memoryUsedBytes" | "memoryTotalBytes"> | null | undefined,
): number | null {
  if (!m || m.memoryUsedBytes == null || m.memoryTotalBytes == null || m.memoryTotalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (m.memoryUsedBytes / m.memoryTotalBytes) * 100));
}

export function diskUsedPercent(
  m: Pick<HostMetrics, "diskAvailableBytes" | "diskTotalBytes"> | null | undefined,
): number | null {
  if (!m || m.diskAvailableBytes == null || m.diskTotalBytes == null || m.diskTotalBytes <= 0) return null;
  const used = Math.max(0, m.diskTotalBytes - m.diskAvailableBytes);
  return Math.min(100, Math.max(0, (used / m.diskTotalBytes) * 100));
}

function sumRates(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Formats transfer rate: `0 B/s`, `48 KB/s`, `12.4 MB/s`, `1.2 GB/s`. */
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "–";
  if (bytesPerSec < 1) return "0 B/s";
  return `${formatSize(bytesPerSec)}/s`;
}

function maxLevel(...levels: PressureLevel[]): PressureLevel {
  if (levels.includes("danger")) return "danger";
  if (levels.includes("warn")) return "warn";
  return "normal";
}

function thresholdLevel(value: number | null, warn: number, danger: number): PressureLevel {
  if (value == null || !Number.isFinite(value)) return "normal";
  if (value >= danger) return "danger";
  if (value >= warn) return "warn";
  return "normal";
}

export function summarizePressure(m: HostMetrics | null, rttMs: number | null): ResourcePressure {
  const cpuLevel = thresholdLevel(m?.cpuPercent ?? null, CPU_WARN_PERCENT, CPU_DANGER_PERCENT);
  const memPct = memoryPercent(m);
  const memoryLevel = thresholdLevel(memPct, MEM_WARN_PERCENT, MEM_DANGER_PERCENT);

  const diskPct = diskUsedPercent(m);
  const avail = m?.diskAvailableBytes ?? null;
  const freeLevel: PressureLevel =
    avail == null
      ? "normal"
      : avail <= DISK_DANGER_FREE_BYTES
        ? "danger"
        : avail <= DISK_WARN_FREE_BYTES
          ? "warn"
          : "normal";
  const diskLevel = maxLevel(thresholdLevel(diskPct, DISK_WARN_PERCENT, DISK_DANGER_PERCENT), freeLevel);
  const rttLevel = thresholdLevel(rttMs, RTT_WARN_MS, RTT_DANGER_MS);

  const netTotal = sumRates(m?.netRxBytesPerSec, m?.netTxBytesPerSec);
  const diskIoTotal = sumRates(m?.diskReadBytesPerSec, m?.diskWriteBytesPerSec);

  return {
    level: maxLevel(cpuLevel, memoryLevel, diskLevel, rttLevel),
    cpuLevel,
    memoryLevel,
    diskLevel,
    rttLevel,
    netSaturated: (netTotal != null && netTotal >= NET_SATURATED_BPS) || rttLevel !== "normal",
    diskSaturated: (diskIoTotal != null && diskIoTotal >= DISK_IO_SATURATED_BPS) || diskLevel !== "normal",
  };
}

/** Compact status bar text beside the 2-bar micro-meter: `24% · 6.2G`. */
export function compactResourceText(m: HostMetrics | null): string {
  const cpu = m?.cpuPercent == null ? "–" : formatPercent(m.cpuPercent);
  const mem = m?.memoryUsedBytes == null ? "–" : formatBytes(m.memoryUsedBytes);
  return `${cpu} · ${mem}`;
}

/** Status bar tooltip summarizing all four subsystems and RTT. */
export function resourceTooltip(m: HostMetrics | null, rttMs: number | null): string {
  if (!m) return "Remote host resources";
  const parts = [
    `CPU ${formatPercent(m.cpuPercent)}`,
    m.memoryTotalBytes != null
      ? `Memory ${formatSize(m.memoryUsedBytes)} / ${formatSize(m.memoryTotalBytes)}`
      : `Memory ${formatSize(m.memoryUsedBytes)}`,
  ];
  const netTotal = sumRates(m.netRxBytesPerSec, m.netTxBytesPerSec);
  if (netTotal != null) {
    parts.push(`Net ↓ ${formatRate(m.netRxBytesPerSec)} ↑ ${formatRate(m.netTxBytesPerSec)}`);
  }
  if (m.diskAvailableBytes != null) {
    parts.push(`Disk ${formatSize(m.diskAvailableBytes)} free`);
  }
  if (rttMs != null) {
    parts.push(`RTT ${formatMs(rttMs)}`);
  }
  return parts.join(" · ");
}

export interface SparklinePaths {
  line: string;
  area: string;
}

/**
 * Builds SVG `d` paths (`line` and filled `area`) across `width × height`.
 * `fixedMax` pins the top of percentage charts to `100`; throughput charts omit
 * `fixedMax` and pass `minCeiling` so idle keepalive bytes stay flat along the baseline.
 */
export function sparklineGeometry(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  options: { fixedMax?: number; minCeiling?: number } = {},
): SparklinePaths | null {
  const known = values.map((v, i) => (v != null && Number.isFinite(v) && v >= 0 ? { i, v } : null)).filter(Boolean) as {
    i: number;
    v: number;
  }[];
  if (!known.length || width <= 0 || height <= 2) return null;

  const peak = known.reduce((acc, p) => Math.max(acc, p.v), 0);
  const ceiling = options.fixedMax ?? Math.max(peak, options.minCeiling ?? 1);
  const pad = 1.5;
  const usableH = height - pad * 2;
  const slots = Math.max(values.length - 1, 1);

  const coords =
    known.length === 1
      ? [
          { x: 0, y: pad + usableH * (1 - Math.min(1, known[0]!.v / ceiling)) },
          { x: width, y: pad + usableH * (1 - Math.min(1, known[0]!.v / ceiling)) },
        ]
      : known.map(({ i, v }) => ({
          x: values.length <= 1 ? width : (i / slots) * width,
          y: pad + usableH * (1 - Math.min(1, v / ceiling)),
        }));

  const fmt = (n: number) => Number(n.toFixed(1));
  const line = coords.map((p, idx) => `${idx === 0 ? "M" : "L"}${fmt(p.x)},${fmt(p.y)}`).join(" ");
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const area = `${line} L${fmt(last.x)},${fmt(height)} L${fmt(first.x)},${fmt(height)} Z`;
  return { line, area };
}

export async function refreshRemoteResources(includeProcesses: boolean): Promise<void> {
  if (!isTauri()) return;
  const { session, lost } = useRemote.getState();
  syncRemoteResourcesSession(session);
  if (!session || lost !== null || !canMonitorRemoteHost(session)) return;
  if (includeProcesses ? inFlightDetailed : inFlightLight || inFlightDetailed) return;

  const epoch = sessionEpoch;
  if (includeProcesses) inFlightDetailed = true;
  else inFlightLight = true;

  const t0 = performance.now();
  try {
    const fresh = await call(commands.hostMetrics(includeProcesses));
    const rttMs = performance.now() - t0;
    if (epoch !== sessionEpoch || useRemote.getState().lost !== null) return;

    useRemoteResources.setState((prev) => {
      // Preserve previously fetched process breakdown across light background ticks so
      // reopening the dashboard renders without an empty-list flash.
      const merged: HostMetrics = includeProcesses
        ? fresh
        : {
            ...fresh,
            processes: prev.metrics?.processes ?? [],
            externalProcesses: prev.metrics?.externalProcesses ?? [],
          };
      const sample: ResourceSample = {
        cpuPercent: fresh.cpuPercent,
        memoryPercent: memoryPercent(fresh),
        netBytesPerSec: sumRates(fresh.netRxBytesPerSec, fresh.netTxBytesPerSec),
        diskBytesPerSec: sumRates(fresh.diskReadBytesPerSec, fresh.diskWriteBytesPerSec),
        rttMs,
      };
      const history = [...prev.history.slice(-(MAX_RESOURCE_SAMPLES - 1)), sample];
      return { metrics: merged, rttMs, history, error: null };
    });
  } catch (e) {
    if (epoch !== sessionEpoch) return;
    useRemoteResources.setState({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (epoch === sessionEpoch) {
      if (includeProcesses) inFlightDetailed = false;
      else inFlightLight = false;
    }
  }
}

export async function endRemoteProcess(pid: number): Promise<void> {
  const epoch = sessionEpoch;
  try {
    await call(commands.hostEndProcess(pid));
    if (epoch !== sessionEpoch) return;
    await refreshRemoteResources(true);
  } catch (e) {
    if (epoch !== sessionEpoch) return;
    useRemoteResources.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}
