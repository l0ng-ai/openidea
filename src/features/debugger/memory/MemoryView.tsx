/** Memory tab of the Debug tool window: live instance counts per class of the debugged JVM. */
import { useEffect, useMemo } from "react";
import clsx from "clsx";
import { Checkbox, Icon, IconButton, Input, List, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { JvmClassRow, JvmMemorySnapshot, JvmMemoryUnavailable } from "@/platform/ipc";
import { sessionSupports, type DebugSession } from "../state";
import { DEFAULT_QUERY, isOutdated, refreshMemory, selectMemoryClass, setMemoryQuery, useMemory } from "./memoryState";
import { InstancesPane } from "./InstancesPane";
import { backendText } from "./instancesTree";
import { keepKeysOnButton } from "./rowButtonKeys";
import { columnsOf, formatBytes, formatCount, formatDelta, queryFor, visibleRows, type SortKey } from "./rows";
import styles from "./MemoryView.module.css";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "name", label: "Class", numeric: false },
  { key: "instances", label: "Count", numeric: true },
  { key: "deltaInstances", label: "Diff", numeric: true },
  { key: "bytes", label: "Shallow Size", numeric: true },
];

const showInstancesOf = (name: string) => void executeAction("debug.memory.showInstances", name);

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

/** `listsInstances`: the session can list the class's instances, which it reads only while paused. */
function ClassRow({
  row,
  sizes,
  listsInstances,
  paused,
}: {
  row: JvmClassRow;
  sizes: boolean;
  listsInstances: boolean;
  paused: boolean;
}) {
  const delta = formatDelta(row.deltaInstances);
  const opens = listsInstances && paused;
  return (
    <div className={styles.row} role="none" onDoubleClick={opens ? () => showInstancesOf(row.name) : undefined}>
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
        {listsInstances && (
          <IconButton
            icon="list"
            action="debug.memory.showInstances"
            actionArg={row.name}
            title="Show Instances"
            size="small"
            className={styles.rowButton}
            disabled={!paused}
            onKeyDown={keepKeysOnButton}
          />
        )}
      </span>
      <span role="cell" className={clsx(styles.cell, styles.num)}>
        {formatCount(row.instances)}
      </span>
      <span role="cell" className={clsx(styles.cell, styles.num, row.deltaInstances === 0 && styles.zero)}>
        {delta}
      </span>
      {sizes && (
        <span role="cell" className={clsx(styles.cell, styles.num)}>
          {formatBytes(row.bytes)}
        </span>
      )}
    </div>
  );
}

export function MemoryView({ session }: { session: DebugSession }) {
  const id = session.id;
  const entry = useMemory((s) => s.bySession[id]);
  const query = entry?.query ?? DEFAULT_QUERY;
  const result = entry?.result ?? null;
  const snapshot = entry?.snapshot ?? null;
  const source = snapshot?.source ?? "histogram";
  const sorted = useMemo(() => queryFor(query, source), [query, source]);
  const listsInstances = sessionSupports("jvmInstances", session);
  const paused = session.status === "paused";
  const backend = backendText(session.jvmBackend);

  // Only the first visit loads: later stops mark the table outdated instead of re-running a heap walk.
  useEffect(() => {
    const e = useMemory.getState().bySession[id];
    if (!e?.result && !e?.loading) void refreshMemory(id);
  }, [id]);

  const rows = useMemo(() => (snapshot ? visibleRows(snapshot.rows, sorted) : []), [snapshot, sorted]);
  const columns = COLUMNS.filter((c) => columnsOf(source).includes(c.key));
  const selected = entry?.selected ?? null;

  const sortBy = (key: SortKey) =>
    setMemoryQuery(id, sorted.sort === key ? { sort: key, desc: !sorted.desc } : { sort: key, desc: key !== "name" });

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
      {backend && (
        <div className={styles.banner} role="status">
          {backend}
        </div>
      )}
      {entry?.loading && listsInstances && paused && (
        <div className={styles.note} role="status">
          <T>Counting objects through the debugger. This can take several seconds on a large heap.</T>
        </div>
      )}
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
          {result.canCountWhenPaused && (
            <>
              {" "}
              <span>
                <T>Pause the program to count objects through the debugger.</T>
              </span>
            </>
          )}
        </div>
      )}
      {snapshot && (
        <div className={clsx(styles.table, source === "debugger" && styles.noSizes)}>
          <div className={styles.grid} role="table" aria-label={tx("Memory")} aria-rowcount={rows.length + 1}>
            <div className={styles.headGroup} role="rowgroup">
              <div className={styles.head} role="row" aria-rowindex={1}>
                {columns.map((c) => (
                  <div
                    key={c.key}
                    role="columnheader"
                    aria-sort={sorted.sort === c.key ? (sorted.desc ? "descending" : "ascending") : "none"}
                    className={clsx(
                      styles.headCell,
                      c.numeric && styles.numeric,
                      sorted.sort === c.key && styles.sorted,
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
              renderItem={(r) => (
                <ClassRow row={r} sizes={source !== "debugger"} listsInstances={listsInstances} paused={paused} />
              )}
              activeIndex={selected == null ? -1 : rows.findIndex((r) => r.name === selected)}
              onActiveChange={(i) => selectMemoryClass(id, rows[i]?.name ?? null)}
              // A click only selects; Enter opens (double-click is handled by the row).
              onActivate={(r, _i, e) => {
                if (e.type === "keydown" && listsInstances && paused) showInstancesOf(r.name);
              }}
              rowHeight={22}
              tableBody={{ headerRows: 1 }}
              empty={<span className={styles.note}>{tx("No matches")}</span>}
            />
          </div>
          <FooterTotals snapshot={snapshot} />
        </div>
      )}
      <InstancesPane session={session} />
    </div>
  );
}

function FooterTotals({ snapshot }: { snapshot: JvmMemorySnapshot }) {
  const n = formatCount(snapshot.rows.length);
  const m = formatCount(snapshot.totalInstances);
  const size = formatBytes(snapshot.totalBytes);
  const counted = snapshot.source === "debugger";
  return (
    <div className={styles.footer}>
      <span>{counted ? tx`${n} classes · ${m} objects` : tx`${n} classes · ${m} objects · ${size}`}</span>
      <span className={styles.source}>
        {counted ? (
          <T>Counted by the debugger: reachable objects only, no sizes.</T>
        ) : (
          <T>Counts include objects that are unreachable but not yet collected.</T>
        )}
      </span>
    </div>
  );
}
