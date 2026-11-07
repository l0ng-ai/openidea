/** Memory tab of the Debug tool window: live instance counts per class of the debugged JVM. */
import { useEffect, useMemo } from "react";
import clsx from "clsx";
import { Checkbox, Icon, IconButton, Input, List, T } from "@/ui";
import { tx } from "@/platform/i18n";
import type { JvmClassRow, JvmMemoryUnavailable } from "@/platform/ipc";
import type { DebugSession } from "../state";
import { DEFAULT_QUERY, isOutdated, refreshMemory, setMemoryQuery, useMemory } from "./memoryState";
import { formatBytes, formatCount, formatDelta, visibleRows, type SortKey } from "./rows";
import styles from "./MemoryView.module.css";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "name", label: "Class", numeric: false },
  { key: "instances", label: "Count", numeric: true },
  { key: "deltaInstances", label: "Diff", numeric: true },
  { key: "bytes", label: "Shallow Size", numeric: true },
];

function unavailableText(reason: JvmMemoryUnavailable): string {
  switch (reason.kind) {
    case "attachedJvmNotFound":
      return tx(
        "Memory view needs a JVM on this computer started with -XX:+StartAttachListener. Programs the IDE debugs get it automatically.",
      );
    case "listenModeNotSupported":
      return tx("Memory view is not available when the IDE listens for the JVM to connect.");
    case "unsupportedPlatform":
      return tx("Memory view is not available on this platform yet.");
    case "noJvmProcess":
      return tx("Could not find the program's JVM process.");
    case "listenerNotRunning":
      return tx(
        "The JVM does not accept attach requests. Restart the debug session without -XX:+DisableAttachMechanism.",
      );
    case "unsafeWhileSuspended": {
      const v = reason.javaMajor;
      return v > 0
        ? tx`JDK ${v} cannot report memory while suspended. Resume the program, then refresh.`
        : tx("This JDK cannot report memory while suspended. Resume the program, then refresh.");
    }
    case "programExited":
      return tx("The program has exited.");
    case "timedOut":
      return tx("The JVM did not answer within 10 seconds.");
  }
}

function ClassRow({ row }: { row: JvmClassRow }) {
  const delta = formatDelta(row.deltaInstances);
  return (
    <div className={styles.row} role="none">
      <span role="cell" className={clsx(styles.cell, styles.className)}>
        <span className={styles.classText}>{row.name}</span>
        {row.ambiguous && (
          <span
            role="img"
            className={styles.ambiguous}
            aria-label={tx("Loaded by more than one class loader")}
            data-tooltip="Loaded by more than one class loader"
          >
            <Icon name="warning" size={12} />
          </span>
        )}
        {row.module && <span className={styles.module}>{row.module}</span>}
      </span>
      <span role="cell" className={clsx(styles.cell, styles.num)}>
        {formatCount(row.instances)}
      </span>
      <span role="cell" className={clsx(styles.cell, styles.num, row.deltaInstances === 0 && styles.zero)}>
        {delta}
      </span>
      <span role="cell" className={clsx(styles.cell, styles.num)}>
        {formatBytes(row.bytes)}
      </span>
    </div>
  );
}

export function MemoryView({ session }: { session: DebugSession }) {
  const id = session.id;
  const entry = useMemory((s) => s.bySession[id]);
  const query = entry?.query ?? DEFAULT_QUERY;
  const result = entry?.result ?? null;
  const snapshot = entry?.snapshot ?? null;

  // Only the first visit loads: later stops mark the table outdated instead of re-running a heap walk.
  useEffect(() => {
    const e = useMemory.getState().bySession[id];
    if (!e?.result && !e?.loading) void refreshMemory(id);
  }, [id]);

  const rows = useMemo(() => (snapshot ? visibleRows(snapshot.rows, query) : []), [snapshot, query]);

  const sortBy = (key: SortKey) =>
    setMemoryQuery(id, query.sort === key ? { desc: !query.desc } : { sort: key, desc: key !== "name" });

  return (
    <div className={styles.root} aria-busy={entry?.loading || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Memory")}>
        <IconButton
          icon="refresh"
          action="debug.memory.refresh"
          title="Refresh Memory View"
          size="small"
          iconSize={16}
          disabled={entry?.loading}
        />
        <Input
          className={styles.filter}
          value={query.filter}
          onChange={(e) => setMemoryQuery(id, { filter: e.target.value })}
          placeholder="Filter classes"
          aria-label="Filter classes"
        />
        <Checkbox
          checked={query.changedOnly}
          onChange={(changedOnly) => setMemoryQuery(id, { changedOnly })}
          label="Changed only"
        />
      </div>
      {entry?.error && (
        <div className={styles.error} role="alert">
          {entry.error}
        </div>
      )}
      {snapshot && entry && isOutdated(entry, session.stops) && (
        <div className={styles.banner} role="status">
          <T>Taken before the last stop. Refresh to update.</T>
        </div>
      )}
      {result?.status === "unavailable" && (
        <div className={snapshot ? styles.banner : styles.note} role={snapshot ? "status" : undefined}>
          {unavailableText(result.reason)}
        </div>
      )}
      {snapshot && (
        <div className={styles.table}>
          <div className={styles.grid} role="table" aria-label={tx("Memory")} aria-rowcount={rows.length + 1}>
            <div className={styles.headGroup} role="rowgroup">
              <div className={styles.head} role="row" aria-rowindex={1}>
                {COLUMNS.map((c) => (
                  <div
                    key={c.key}
                    role="columnheader"
                    aria-sort={query.sort === c.key ? (query.desc ? "descending" : "ascending") : "none"}
                    className={clsx(
                      styles.headCell,
                      c.numeric && styles.numeric,
                      query.sort === c.key && styles.sorted,
                    )}
                  >
                    <button type="button" onClick={() => sortBy(c.key)}>
                      <T>{c.label}</T>
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <List
              className={styles.list}
              items={rows}
              getKey={(r, i) => `${i}:${r.name}`}
              renderItem={(r) => <ClassRow row={r} />}
              rowHeight={22}
              tableBody={{ headerRows: 1 }}
              empty={<span className={styles.note}>{tx("No matches")}</span>}
            />
          </div>
          <FooterTotals snapshot={snapshot} />
        </div>
      )}
    </div>
  );
}

function FooterTotals({ snapshot }: { snapshot: { rows: JvmClassRow[]; totalInstances: number; totalBytes: number } }) {
  const n = formatCount(snapshot.rows.length);
  const m = formatCount(snapshot.totalInstances);
  const size = formatBytes(snapshot.totalBytes);
  return (
    <div className={styles.footer}>
      <span>{tx`${n} classes · ${m} objects · ${size}`}</span>
      <span className={styles.source}>
        <T>Counts include objects that are unreachable but not yet collected.</T>
      </span>
    </div>
  );
}
