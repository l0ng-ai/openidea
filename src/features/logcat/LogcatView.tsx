/**
 * Logcat tool window: the device picker, the level and text filters, and the
 * streaming log below them (virtualised, following the tail until scrolled up).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Channel } from "@tauri-apps/api/core";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import type { LogcatLevel, LogcatLine } from "@/platform/ipc";
import { Input, IconButton, Select, T, EmptyState, Toggle } from "@/ui";
import { FILTER_LEVELS, LEVEL_CLASS, filterLines, shortTime } from "./model";
import { compileQuery } from "./query";
import { appendLines, clearLines, setDevices, setDevicesError, setPaused, setStatus, useLogcat } from "./store";
import styles from "./Logcat.module.css";

/** Rows are measured: a wrapped message makes its row taller. */
const ROW_HEIGHT = 22;
const LEVEL_LABELS: Record<LogcatLevel, string> = {
  verbose: "Verbose",
  debug: "Debug",
  info: "Info",
  warn: "Warnings",
  error: "Errors",
  fatal: "Fatal",
  unknown: "Unknown",
};

/** The device whose log the buffer holds: reopening the window keeps it, switching
 * devices starts clean. */
let bufferedFor: string | null = null;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function LogcatView() {
  const devices = useLogcat((s) => s.devices);
  const devicesError = useLogcat((s) => s.devicesError);
  const loadingDevices = useLogcat((s) => s.loadingDevices);
  const serial = useLogcat((s) => s.serial);
  const level = useLogcat((s) => s.level);
  const query = useLogcat((s) => s.query);
  const paused = useLogcat((s) => s.paused);
  const follow = useLogcat((s) => s.follow);
  const status = useLogcat((s) => s.status);
  const error = useLogcat((s) => s.error);
  const lines = useLogcat((s) => s.lines);

  const refreshDevices = useCallback(() => {
    useLogcat.setState({ loadingDevices: true });
    call(commands.androidDevices())
      .then(setDevices)
      .catch((e) => setDevicesError(message(e)));
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** The view is at the bottom, so new lines keep it there. */
  const stick = useRef(true);

  // One stream per device: switching devices (or closing the window) cancels it.
  useEffect(() => {
    if (!serial) {
      setStatus("idle");
      return;
    }
    if (bufferedFor !== serial) {
      clearLines();
      bufferedFor = serial;
      stick.current = true;
    }
    const request = nextRequestId();
    const channel = new Channel<LogcatLine[]>();
    channel.onmessage = (batch) => appendLines(batch);
    setStatus("running");
    call(commands.androidLogcat(request, serial, false, channel))
      .then(() => setStatus("idle"))
      .catch((e) => {
        if (isCancelled(e)) setStatus("idle");
        else setStatus("error", message(e));
      });
    return () => {
      void commands.cancelRequest(request);
    };
  }, [serial]);

  const rows = useMemo(() => filterLines(lines, level, query), [lines, level, query]);
  const filterError = useMemo(() => compileQuery(query).error, [query]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    // Rows are identified by their line, not by position: the buffer drops old lines.
    getItemKey: (index) => rows[index]!.id,
    overscan: 16,
  });

  // Follow the tail while the view is scrolled to the bottom (IDEA's soft wrap off /
  // "Scroll to End" behaviour); scrolling up stops it until scrolled back down.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, follow]);

  const deviceOptions = devices.map((d) => ({
    value: d.serial,
    label: d.model ? `${d.model} (${d.serial})` : d.serial,
    detail: d.state === "device" ? undefined : d.state,
    disabled: d.state !== "device",
  }));

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Select
          className={styles.device}
          aria-label={"Device"}
          placeholder="No devices"
          value={serial}
          options={deviceOptions}
          onChange={(value) => useLogcat.setState({ serial: value })}
        />
        <Select
          className={styles.level}
          aria-label={"Minimum level"}
          value={level}
          options={FILTER_LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] }))}
          onChange={(value) => useLogcat.setState({ level: value })}
        />
        <Input
          className={styles.search}
          placeholder="Filter, e.g. tag:glide -message:bitmap level:error"
          aria-label={"Filter log lines"}
          title={"tag: · message: · pid: · level: · -term · a|b · (a|b) -c · message~:regex"}
          invalid={filterError !== null}
          value={query}
          onChange={(e) => useLogcat.setState({ query: e.target.value })}
        />
        <IconButton
          icon={paused ? "resume" : "pause"}
          title={paused ? "Resume" : "Pause"}
          size="small"
          pressed={paused}
          onClick={() => setPaused(!paused)}
        />
        <IconButton icon="trash" title="Clear" size="small" onClick={clearLines} />
        <Toggle checked={follow} onChange={(v) => useLogcat.setState({ follow: v })} label="Scroll to end" />
        <IconButton
          icon="refresh"
          title="Refresh devices"
          size="small"
          disabled={loadingDevices}
          onClick={refreshDevices}
        />
      </div>

      {devicesError ? (
        <EmptyState title="No Android devices">
          <span>{devicesError}</span>
        </EmptyState>
      ) : !devices.length ? (
        <EmptyState title={loadingDevices ? "Looking for devices…" : "No Android devices"}>
          <span>
            <T>Connect a device over USB, or start an emulator. Logcat uses the Android SDK's adb.</T>
          </span>
        </EmptyState>
      ) : (
        <div
          ref={scrollRef}
          className={styles.log}
          role="log"
          aria-label={"Device log"}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = rows[item.index]!;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className={clsx(styles.row, styles[LEVEL_CLASS[line.level]])}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <span className={styles.time}>{shortTime(line.time)}</span>
                  <span className={styles.pid}>{line.pid || ""}</span>
                  <span className={styles.tag}>{line.tag}</span>
                  <span className={styles.message}>{line.message}</span>
                </div>
              );
            })}
          </div>
          {!rows.length && (
            <div className={styles.empty}>
              {lines.length ? <T>No lines match the filter</T> : <T>Waiting for output…</T>}
            </div>
          )}
        </div>
      )}

      <div className={styles.status}>
        <span>{status === "running" ? <T>Streaming</T> : status === "error" ? <T>Stopped</T> : <T>Idle</T>}</span>
        {paused && <span className={styles.warn}>Paused</span>}
        {filterError && <span className={styles.error}>Filter ignored: {filterError}</span>}
        <span className={styles.count}>
          {rows.length === lines.length ? lines.length : `${rows.length} / ${lines.length}`}
        </span>
        {error && <span className={styles.error}>{error}</span>}
      </div>
    </div>
  );
}
