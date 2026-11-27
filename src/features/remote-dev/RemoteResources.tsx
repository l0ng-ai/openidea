import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { t, tx } from "@/platform/i18n";
import { isTauri, type HostMetrics, type HostProcess } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { BarButton, Button, Dialog, IconButton, Popup, showContextMenu, T } from "@/ui";
import { formatBytes, formatMs, formatPercent, formatSize, formatUptime } from "@/features/perf/format";
import { memorySections, type BreakdownRow } from "@/features/perf/memory";
import { startPolling } from "@/features/perf/poll";
import { remoteBadge } from "./RemoteStatus";
import {
  canMonitorRemoteHost,
  compactResourceText,
  diskUsedPercent,
  endRemoteProcess,
  formatRate,
  memoryPercent,
  refreshRemoteResources,
  REMOTE_DASHBOARD_POLL_MS,
  REMOTE_METRICS_POLL_MS,
  resourceTooltip,
  sparklineGeometry,
  summarizePressure,
  useRemoteResources,
  type PressureLevel,
  type ResourceSample,
} from "./resources";
import styles from "./RemoteResources.module.css";

export const REMOTE_RESOURCES_WIDGET = {
  id: "remote.resources",
  title: "Remote Host Resources",
  defaultVisible: true,
} as const;

const SPARK_W = 176;
const SPARK_H = 28;
const MIN_NET_CEILING_BPS = 256 * 1024;
const MIN_DISK_CEILING_BPS = 512 * 1024;

function barHeightPercent(percent: number | null): string {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return "0%";
  return `${Math.min(100, Math.max(15, Math.round(percent)))}%`;
}

function fillLevelClass(level: PressureLevel): string | undefined {
  if (level === "danger") return styles.meterFillDanger;
  if (level === "warn") return styles.meterFillWarn;
  return undefined;
}

function sparkLevelClass(level: PressureLevel): string | undefined {
  if (level === "danger") return styles.sparkDanger;
  if (level === "warn") return styles.sparkWarn;
  return undefined;
}

function Sparkline({
  values,
  level = "normal",
  fixedMax,
  minCeiling,
}: {
  values: ReadonlyArray<number | null>;
  level?: PressureLevel;
  fixedMax?: number;
  minCeiling?: number;
}) {
  const paths = sparklineGeometry(values, SPARK_W, SPARK_H, { fixedMax, minCeiling });
  return (
    <svg
      className={clsx(styles.sparkline, sparkLevelClass(level))}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths && (
        <>
          <path className={styles.sparkArea} d={paths.area} />
          <path className={styles.sparkStroke} d={paths.line} />
        </>
      )}
    </svg>
  );
}

export function RemoteResources() {
  const session = useRemote((s) => s.session);
  const lost = useRemote((s) => s.lost !== null);
  const metrics = useRemoteResources((s) => s.metrics);
  const rttMs = useRemoteResources((s) => s.rttMs);
  const history = useRemoteResources((s) => s.history);
  const open = useRemoteResources((s) => s.popupOpen);
  const ref = useRef<HTMLButtonElement>(null);

  const active = Boolean(session && !lost && canMonitorRemoteHost(session));

  useEffect(() => {
    if (!isTauri() || !active) return;
    const intervalMs = open ? REMOTE_DASHBOARD_POLL_MS : REMOTE_METRICS_POLL_MS;
    return startPolling(() => void refreshRemoteResources(open), { intervalMs });
  }, [active, open]);

  if (!active || !session) return null;

  const pressure = summarizePressure(metrics, rttMs);
  const memPct = memoryPercent(metrics);
  const tooltip = resourceTooltip(metrics, rttMs);
  const compact = compactResourceText(metrics);

  return (
    <>
      <BarButton
        ref={ref}
        className={clsx(
          styles.pill,
          pressure.level === "warn" && styles.levelWarn,
          pressure.level === "danger" && styles.levelDanger,
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={tx`Remote host resources: ${tooltip}`}
        tooltip={tooltip}
        onClick={() => useRemoteResources.setState({ popupOpen: !open })}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e, [
            { kind: "action", action: "remote.showResources" },
            { kind: "action", action: "remote.reloadEnvironment" },
            { kind: "separator" },
            { kind: "action", action: "remote.disconnect" },
            { kind: "action", action: "remote.stopBackend" },
          ]);
        }}
      >
        <span className={styles.meter} aria-hidden="true">
          <span className={styles.meterTrack}>
            <span
              className={clsx(styles.meterFill, fillLevelClass(pressure.cpuLevel))}
              style={{ height: barHeightPercent(metrics?.cpuPercent ?? null) }}
            />
          </span>
          <span className={styles.meterTrack}>
            <span
              className={clsx(styles.meterFill, fillLevelClass(pressure.memoryLevel))}
              style={{ height: barHeightPercent(memPct) }}
            />
          </span>
        </span>
        <span className={styles.pillText}>{compact}</span>
        {pressure.netSaturated && (
          <span className={clsx(styles.badge, pressure.rttLevel === "danger" && styles.badgeDanger)}>
            {pressure.rttLevel !== "normal" && rttMs != null ? formatMs(rttMs) : <T>Net</T>}
          </span>
        )}
        {pressure.diskSaturated && (
          <span className={clsx(styles.badge, pressure.diskLevel === "danger" && styles.badgeDanger)}>
            <T>Disk</T>
          </span>
        )}
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-start"
        offset={6}
        onClose={() => useRemoteResources.setState({ popupOpen: false })}
        aria-label="Remote Host Resources"
      >
        <RemoteResourcesDashboard hostLabel={remoteBadge(session)} metrics={metrics} rttMs={rttMs} history={history} />
      </Popup>
    </>
  );
}

function ProcessRow({
  row,
  trusted,
  onRequestEnd,
}: {
  row: BreakdownRow;
  trusted: boolean;
  onRequestEnd: (row: BreakdownRow) => void;
}) {
  const title = row.processes > 1 ? tx`PID ${row.pid} · ${row.processes} processes` : tx`PID ${row.pid}`;
  return (
    <div className={clsx(styles.processRow, styles.indented)} title={title}>
      <span className={styles.rowLabel}>
        {row.label}
        {row.detail && <span className={styles.detail}>{row.detail}</span>}
      </span>
      <span className={clsx(styles.metricCol, styles.cpu)}>{row.cpu}</span>
      <span className={clsx(styles.metricCol, styles.memory)}>{row.value}</span>
      <span className={styles.end}>
        {row.endable && trusted && (
          <IconButton
            icon="close"
            size="small"
            iconSize={14}
            title={tx`End Process ${row.label}`}
            onClick={() => onRequestEnd(row)}
          />
        )}
      </span>
    </div>
  );
}

function ExternalProcessRow({ proc }: { proc: HostProcess }) {
  return (
    <div className={clsx(styles.processRow, styles.indented)} title={tx`PID ${proc.pid}`}>
      <span className={styles.rowLabel}>{proc.name}</span>
      <span className={clsx(styles.metricCol, styles.cpu)}>{formatPercent(proc.cpuPercent)}</span>
      <span className={clsx(styles.metricCol, styles.memory)}>{formatSize(proc.memoryBytes)}</span>
      <span className={styles.end} />
    </div>
  );
}

export function RemoteResourcesDashboard({
  hostLabel,
  metrics: m,
  rttMs,
  history,
}: {
  hostLabel: string;
  metrics: HostMetrics | null;
  rttMs: number | null;
  history: ReadonlyArray<ResourceSample>;
}) {
  const error = useRemoteResources((s) => s.error);
  const trusted = useProject((s) => s.project?.trusted !== false);
  const [confirmingRow, setConfirmingRow] = useState<BreakdownRow | null>(null);
  const pressure = summarizePressure(m, rttMs);
  const memPct = memoryPercent(m);
  const diskPct = diskUsedPercent(m);
  const sections = memorySections(m?.processes ?? []);
  const external = m?.externalProcesses ?? [];

  const loadText =
    m?.loadAverage && m.loadAverage.every((v) => v != null)
      ? m.loadAverage.map((v) => v!.toFixed(2)).join(" · ")
      : null;
  const cpuCores = m?.cpuCores ?? 0;
  const cpuSub =
    cpuCores <= 0
      ? tx("Sampling…")
      : loadText
        ? cpuCores === 1
          ? tx`1 core · load ${loadText}`
          : tx`${cpuCores} cores · load ${loadText}`
        : cpuCores === 1
          ? tx("1 core")
          : tx`${cpuCores} cores`;

  const memValue =
    m?.memoryTotalBytes != null
      ? `${formatBytes(m.memoryUsedBytes)} / ${formatBytes(m.memoryTotalBytes)}`
      : formatSize(m?.memoryUsedBytes);
  const memAvail =
    m?.memoryTotalBytes != null && m.memoryUsedBytes != null
      ? Math.max(0, m.memoryTotalBytes - m.memoryUsedBytes)
      : null;
  const memSub = memPct != null && memAvail != null ? tx`${formatPercent(memPct)} · ${formatSize(memAvail)} free` : "–";

  const hasNetRates = m?.netRxBytesPerSec != null || m?.netTxBytesPerSec != null;
  const netTotal = hasNetRates ? (m?.netRxBytesPerSec ?? 0) + (m?.netTxBytesPerSec ?? 0) : null;
  const netValue = hasNetRates ? formatRate(netTotal) : "–";
  const netSub = hasNetRates
    ? `↓ ${formatBytes(m?.netRxBytesPerSec)}/s · ↑ ${formatBytes(m?.netTxBytesPerSec)}/s${rttMs != null ? ` · ${formatMs(rttMs)}` : ""}`
    : rttMs != null
      ? tx`SSH / RPC RTT ${formatMs(rttMs)}`
      : "–";

  const hasDiskIo = m?.diskReadBytesPerSec != null || m?.diskWriteBytesPerSec != null;
  const diskValue = m?.diskAvailableBytes != null ? tx`${formatSize(m.diskAvailableBytes)} free` : "–";
  const diskSub = hasDiskIo
    ? `R ${formatBytes(m?.diskReadBytesPerSec)}/s · W ${formatBytes(m?.diskWriteBytesPerSec)}/s`
    : m?.diskTotalBytes != null && diskPct != null
      ? tx`${formatPercent(diskPct)} of ${formatSize(m.diskTotalBytes)} used`
      : "–";

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.hostInfo}>
          <span className={styles.hostTitle}>{hostLabel}</span>
          {m?.uptimeMs != null && <span className={styles.uptime}>{tx`up ${formatUptime(m.uptimeMs)}`}</span>}
        </div>
        {rttMs != null && (
          <span
            className={clsx(
              styles.rttBadge,
              pressure.rttLevel === "warn" && styles.rttWarn,
              pressure.rttLevel === "danger" && styles.rttDanger,
            )}
            title={tx("Round-trip latency to remote backend")}
          >
            {tx`RTT ${formatMs(rttMs)}`}
          </span>
        )}
      </div>

      <div className={styles.grid}>
        <div className={styles.card} role="group" aria-label={tx("CPU")}>
          <div className={styles.cardTop}>
            <span className={styles.cardTitle}>
              <T>CPU</T>
            </span>
            <span className={clsx(styles.cardValue, pressure.cpuLevel === "danger" && styles.levelDanger)}>
              {formatPercent(m?.cpuPercent)}
            </span>
          </div>
          <span className={styles.cardSub}>{cpuSub}</span>
          <Sparkline values={history.map((s) => s.cpuPercent)} level={pressure.cpuLevel} fixedMax={100} />
        </div>

        <div className={styles.card} role="group" aria-label={tx("Memory")}>
          <div className={styles.cardTop}>
            <span className={styles.cardTitle}>
              <T>Memory</T>
            </span>
            <span className={clsx(styles.cardValue, pressure.memoryLevel === "danger" && styles.levelDanger)}>
              {memValue}
            </span>
          </div>
          <span className={styles.cardSub}>{memSub}</span>
          <Sparkline values={history.map((s) => s.memoryPercent)} level={pressure.memoryLevel} fixedMax={100} />
        </div>

        <div className={styles.card} role="group" aria-label={tx("Network")}>
          <div className={styles.cardTop}>
            <span className={styles.cardTitle}>
              <T>Network</T>
            </span>
            <span className={styles.cardValue}>{netValue}</span>
          </div>
          <span className={styles.cardSub}>{netSub}</span>
          <Sparkline
            values={history.map((s) => s.netBytesPerSec)}
            level={pressure.rttLevel}
            minCeiling={MIN_NET_CEILING_BPS}
          />
        </div>

        <div className={styles.card} role="group" aria-label={tx("Disk")}>
          <div className={styles.cardTop}>
            <span className={styles.cardTitle}>
              <T>Disk</T>
            </span>
            <span className={clsx(styles.cardValue, pressure.diskLevel === "danger" && styles.levelDanger)}>
              {diskValue}
            </span>
          </div>
          <span className={styles.cardSub}>{diskSub}</span>
          {hasDiskIo ? (
            <Sparkline
              values={history.map((s) => s.diskBytesPerSec)}
              level={pressure.diskLevel}
              minCeiling={MIN_DISK_CEILING_BPS}
            />
          ) : (
            <div className={styles.capacityTrack} aria-hidden="true">
              <div
                className={clsx(
                  styles.capacityFill,
                  pressure.diskLevel === "warn" && styles.capacityWarn,
                  pressure.diskLevel === "danger" && styles.capacityDanger,
                )}
                style={{ width: `${Math.round(diskPct ?? 0)}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {(sections.length > 0 || external.length > 0) && (
        <div className={styles.section}>
          <div className={styles.columns}>
            <span className={styles.columnsTitle}>
              <T>Processes</T>
            </span>
            <span className={styles.cpu}>
              <T>CPU</T>
            </span>
            <span className={styles.memory}>
              <T>Memory</T>
            </span>
            <span className={styles.end} />
          </div>
          {sections.map((sec) => (
            <div key={sec.title} role="group" aria-label={tx(sec.title)}>
              <div className={styles.groupRow}>
                <span className={styles.groupTitle}>{tx(sec.title)}</span>
                <span className={clsx(styles.metricCol, styles.cpu)}>{sec.cpu}</span>
                <span className={clsx(styles.metricCol, styles.memory)}>{sec.total}</span>
                <span className={styles.end} />
              </div>
              {sec.rows.map((r) => (
                <ProcessRow key={r.key} row={r} trusted={trusted} onRequestEnd={setConfirmingRow} />
              ))}
            </div>
          ))}
          {external.length > 0 && (
            <div role="group" aria-label={tx("Other host processes")}>
              <div className={styles.groupRow}>
                <span className={styles.groupTitle}>
                  <T>Other host processes</T>
                </span>
                <span className={clsx(styles.metricCol, styles.cpu)} />
                <span className={clsx(styles.metricCol, styles.memory)} />
                <span className={styles.end} />
              </div>
              {external.map((proc) => (
                <ExternalProcessRow key={proc.pid} proc={proc} />
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.actions}>
        <Button size="small" onClick={() => void executeAction("remote.reloadEnvironment")}>
          <T>Reload Environment</T>
        </Button>
        <Button size="small" onClick={() => void executeAction("remote.stopBackend")}>
          <T>Stop Backend</T>
        </Button>
      </div>

      <Dialog
        open={confirmingRow !== null}
        blockWorkbenchShortcuts
        icon="warning"
        title={tx("End Remote Process")}
        width={460}
        onClose={() => setConfirmingRow(null)}
        buttons={[
          {
            label: tx("End Process"),
            role: "default",
            autoFocus: true,
            onClick: () => {
              const target = confirmingRow;
              setConfirmingRow(null);
              if (target) void endRemoteProcess(target.pid);
            },
          },
          { label: t("common.cancel"), role: "cancel" },
        ]}
      >
        {confirmingRow &&
          (confirmingRow.processes > 1
            ? tx`End '${confirmingRow.label}' (PID ${confirmingRow.pid}) and its child processes on the remote host?`
            : tx`End '${confirmingRow.label}' (PID ${confirmingRow.pid}) on the remote host?`)}
      </Dialog>
    </div>
  );
}
