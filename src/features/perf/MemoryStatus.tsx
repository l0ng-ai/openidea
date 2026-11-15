/**
 * Memory indicator ("OpenIDEA 560M") with a details popup. Unlike IDEA's JVM heap
 * there is no maximum to measure headroom against, so the widget shows the
 * footprint of OpenIDEA's own processes and no fill bar; the popup breaks down
 * OpenIDEA, language servers and other processes.
 */
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { BarButton, Button, IconButton, Popup, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type AppMetrics } from "@/platform/ipc";
import { formatBytes, formatCount, formatMs, formatSize, formatUptime } from "./format";
import { indicatorLabel, indicatorTooltip, memorySections, summarizeMemory, type BreakdownRow } from "./memory";
import { startPolling } from "./poll";
import { METRICS_INTERVAL_MS, refreshMetrics, usePerf } from "./store";
import styles from "./perf.module.css";
import { tx } from "@/platform/i18n";

/** Status bar widget id (hidden by default, toggled from the status bar context menu). */
export const MEMORY_WIDGET = { id: "perf.memory", title: "Memory Indicator", defaultVisible: false } as const;

export function MemoryStatus() {
  const metrics = usePerf((s) => s.metrics);
  const open = usePerf((s) => s.popupOpen);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    return startPolling(() => void refreshMetrics(), { intervalMs: METRICS_INTERVAL_MS });
  }, []);
  useEffect(() => {
    if (open) void refreshMetrics();
  }, [open]);

  if (!metrics) return null;
  const summary = summarizeMemory(metrics);
  const label = indicatorLabel(summary);
  const tooltip = indicatorTooltip(summary);
  return (
    <>
      <BarButton
        ref={ref}
        className={styles.indicator}
        aria-expanded={open}
        aria-label={tx`Memory: ${tooltip}`}
        tooltip={tooltip}
        onClick={() => usePerf.setState({ popupOpen: !open })}
      >
        {label}
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={() => usePerf.setState({ popupOpen: false })}
        aria-label="Memory and diagnostics"
      >
        <MemoryDetails metrics={metrics} />
      </Popup>
    </>
  );
}

interface RowProps {
  label: string;
  detail?: string | null;
  value: string;
  title?: string;
  indented?: boolean;
}

function Row({ label, detail, value, title, indented }: RowProps) {
  return (
    <div className={clsx(styles.row, indented && styles.indented)} title={title}>
      <span className={styles.label}>
        {label}
        {detail && <span className={styles.detail}>{detail}</span>}
      </span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}

async function endProcess(pid: number) {
  const error = await call(commands.endProcess(pid)).then(
    () => null,
    (e: unknown) => String(e),
  );
  await refreshMetrics();
  if (error) usePerf.setState({ error });
}

function ProcessRow({ row }: { row: BreakdownRow }) {
  const title = row.processes > 1 ? tx`PID ${row.pid} · ${row.processes} processes` : tx`PID ${row.pid}`;
  return (
    <div className={clsx(styles.row, styles.indented, styles.processRow)} title={title}>
      <span className={styles.label}>
        {row.label}
        {row.detail && <span className={styles.detail}>{row.detail}</span>}
      </span>
      <span className={clsx(styles.value, styles.cpu)}>{row.cpu}</span>
      <span className={clsx(styles.value, styles.memory)}>{row.value}</span>
      <span className={styles.end}>
        {row.endable && (
          <IconButton
            icon="close"
            size="small"
            iconSize={14}
            title={tx`End Process ${row.label}`}
            onClick={() => void endProcess(row.pid)}
          />
        )}
      </span>
    </div>
  );
}

export function MemoryDetails({ metrics: m }: { metrics: AppMetrics }) {
  const error = usePerf((s) => s.error);
  const s = m.syntax;
  const summary = summarizeMemory(m);
  const sections = memorySections(m.memory ?? []);
  return (
    <div className={styles.panel}>
      <div className={clsx(styles.header, styles.columns)}>
        <span className={styles.groupTitle}>{tx("Memory & Diagnostics")}</span>
        <span className={styles.cpu}>
          <T>CPU</T>
        </span>
        <span className={styles.memory}>
          <T>Memory</T>
        </span>
        <span className={styles.end} />
      </div>
      {sections.map((sec) => (
        <div key={sec.title} className={styles.section} aria-label={sec.title} role="group">
          <div className={clsx(styles.groupRow, styles.processRow)}>
            <span className={styles.groupTitle}>{sec.title}</span>
            <span className={clsx(styles.value, styles.cpu)}>{sec.cpu}</span>
            <span className={clsx(styles.value, styles.memory)}>{sec.total}</span>
            <span className={styles.end} />
          </div>
          {sec.rows.map((r) => (
            <ProcessRow key={r.key} row={r} />
          ))}
        </div>
      ))}
      <div className={styles.section}>
        <div className={styles.groupRow}>
          <span className={styles.groupTitle}>
            <T>Total</T>
          </span>
          <span className={styles.value}>{formatSize(summary.total)}</span>
        </div>
        <Row label="Physical memory" value={formatSize(m.totalMemoryBytes)} />
        {m.heapBytes != null && <Row label="Backend malloc in use" value={formatBytes(m.heapBytes)} />}
      </div>
      <div className={styles.section}>
        <Row label="Open documents" value={formatCount(m.openDocuments)} />
        <Row
          label={m.indexing ? "Index (indexing…)" : "Index"}
          value={`${formatCount(m.indexFiles)} files · ${formatCount(m.indexSymbols)} symbols`}
        />
        <Row label="Syntax trees" value={`${s.trees} / ${s.documents} docs · ${formatBytes(s.treeTextBytes)}`} />
        <Row
          label="Parses (hit / incr. / full)"
          value={`${formatCount(s.hits)} / ${formatCount(s.incrementalParses)} / ${formatCount(s.fullParses)}`}
        />
      </div>
      <div className={styles.section}>
        <Row label="Uptime" value={formatUptime(m.uptimeMs)} />
        <Row label="Process → main" value={formatMs(m.startup.processToMainMs)} />
        <Row label="Process → backend ready" value={formatMs(m.startup.processToSetupMs)} />
        <Row label="Backend set-up" value={formatMs(m.startup.setupMs)} />
        <Row label="Process → first IPC" value={formatMs(m.startup.firstIpcMs)} />
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.actions}>
        <Button size="small" icon="trash" onClick={() => void executeAction("file.invalidateCaches")}>
          <T>Clear caches</T>
        </Button>
      </div>
    </div>
  );
}
