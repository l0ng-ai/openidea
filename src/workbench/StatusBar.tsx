import { create } from "zustand";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { BarButton, IconButton, Popup, ProgressBar, showContextMenu, T, tooltipAttrs } from "@/ui";
import { useContributions, useStatusInfo, type StatusItemContribution } from "./contributions";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  isStatusItemVisible,
  statusBarMenu,
  useStatusWidgetOverrides,
  useUnavailableStatusWidgets,
} from "./statusBarWidgets";
import { cancelTask, canCancel, useTasks, type BackgroundTask } from "./tasks";
import styles from "./StatusBar.module.css";
import { tx } from "@/platform/i18n";

/**
 * Orders status items: on both sides a higher priority sits closer to the
 * window edge, so left items sort descending and right items ascending.
 */
export function orderStatusItems(items: Iterable<StatusItemContribution>) {
  const all = [...items];
  const left = all
    .filter((i) => i.align === "left")
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const right = all
    .filter((i) => i.align === "right")
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return { left, right };
}

export interface MeasuredStatusItem {
  id: string;
  priority: number;
  width: number;
}

/**
 * Right items that don't fit in `available` px: the lowest priorities move into the overflow
 * button (`moreWidth` wide) first. Each item also takes one `gap`; empty items take nothing.
 */
export function overflowingStatusItems(
  items: readonly MeasuredStatusItem[],
  available: number,
  gap: number,
  moreWidth: number,
): Set<string> {
  const shown = items.filter((i) => i.width > 0);
  let total = shown.reduce((sum, i) => sum + i.width + gap, 0);
  const out = new Set<string>();
  if (total <= available) return out;
  const budget = available - moreWidth - gap;
  for (const i of [...shown].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    if (total <= budget) break;
    out.add(i.id);
    total -= i.width + gap;
  }
  return out;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** `lightEdit`: a LightEdit window's bar, with the items that apply there only. */
export function StatusBar({ lightEdit = false }: { lightEdit?: boolean }) {
  const map = useContributions((s) => s.statusItems);
  const overrides = useStatusWidgetOverrides();
  const { left, right } = useMemo(
    () => orderStatusItems([...map.values()].filter((i) => !lightEdit || i.lightEdit)),
    [map, lightEdit],
  );
  const unavailable = useUnavailableStatusWidgets();
  const visible = (i: StatusItemContribution) => !unavailable.has(i.id) && isStatusItemVisible(i, overrides);
  const shownRight = right.filter(visible);
  const [overflow, setOverflow] = useState<ReadonlySet<string>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // Each right item renders into its own element for good; it moves between the bar and the
  // overflow popup, so a widget never remounts (its state and open popups survive).
  const [dom] = useState(() => ({
    hosts: new Map<string, HTMLDivElement>(),
    barSlots: new Map<string, HTMLElement>(),
    popupSlots: new Map<string, HTMLElement>(),
  }));
  const { hosts, barSlots, popupSlots } = dom;
  const host = (id: string) => {
    let el = hosts.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = styles.item!;
      el.dataset.statusItem = id;
      hosts.set(id, el);
    }
    return el;
  };
  const slot = (slots: Map<string, HTMLElement>, id: string) => (el: HTMLElement | null) => {
    if (el) slots.set(id, el);
  };
  const anyHidden = shownRight.some((i) => overflow.has(i.id));
  // Everything fits again: the popup doesn't reopen by itself the next time something overflows.
  if (moreOpen && !anyHidden) setMoreOpen(false);
  const showMore = moreOpen && anyHidden;

  const measure = useRef(() => {});
  const observer = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure.current());
    observer.current = ro;
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    measure.current = () => {
      const bar = barRef.current;
      if (!bar) return;
      const css = getComputedStyle(bar);
      const gap = parseFloat(css.columnGap) || 0;
      const spacer = spacerRef.current;
      // Left items shrink instead (down to their gap); the spacer keeps its minimum.
      const leftShown = [...bar.querySelectorAll<HTMLElement>(":scope > [data-status-item]")].filter(
        (el) => el.getClientRects().length > 0,
      ).length;
      const available =
        bar.clientWidth -
        (parseFloat(css.paddingLeft) || 0) -
        (parseFloat(css.paddingRight) || 0) -
        (spacer ? parseFloat(getComputedStyle(spacer).minWidth) || 0 : 0) -
        leftShown * gap;
      const items = shownRight.map((i) => ({
        id: i.id,
        priority: i.priority,
        width: Math.ceil(hosts.get(i.id)?.getBoundingClientRect().width ?? 0),
      }));
      const more = moreRef.current?.getBoundingClientRect().width || 24;
      const next = overflowingStatusItems(items, available, gap, more);
      setOverflow((prev) => (sameSet(prev, next) ? prev : next));
    };
    const ro = observer.current;
    for (const i of shownRight) {
      const el = host(i.id);
      const target = (showMore && overflow.has(i.id) && popupSlots.get(i.id)) || barSlots.get(i.id);
      if (target?.isConnected && el.parentElement !== target) target.appendChild(el);
      ro?.observe(el);
    }
    // The spacer changes width whenever an item comes or goes; the bar, when the window resizes.
    for (const el of [spacerRef.current, barRef.current, moreRef.current]) if (el) ro?.observe(el);
  });

  const renderLeft = (item: StatusItemContribution) => {
    const C = item.component;
    return (
      <div key={item.id} className={clsx(styles.item, styles.shrink)} data-status-item={item.id}>
        <ErrorBoundary name={`status item ${item.id}`}>
          <C />
        </ErrorBoundary>
      </div>
    );
  };
  const hidden = shownRight.filter((i) => overflow.has(i.id));
  return (
    <footer
      ref={barRef}
      className={styles.bar}
      aria-label={tx("Status bar")}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        showContextMenu(e, statusBarMenu([...left, ...right], overrides));
      }}
    >
      {left.filter(visible).map(renderLeft)}
      <div ref={spacerRef} className={styles.spacer} />
      {shownRight.map((i) => (
        // A hidden item waits out of the flow at the bar's end, so a popup it opens anchors there.
        <div key={i.id} ref={slot(barSlots, i.id)} className={overflow.has(i.id) ? styles.overflowed : styles.slot} />
      ))}
      {hidden.length > 0 && (
        <IconButton
          ref={moreRef}
          icon="more-horizontal"
          size="small"
          title="Show more"
          aria-haspopup="dialog"
          aria-expanded={showMore}
          className={styles.more}
          onClick={() => setMoreOpen(!showMore)}
        />
      )}
      <Popup
        open={showMore}
        anchor={moreRef}
        placement="top-end"
        offset={6}
        trapFocus
        onClose={() => setMoreOpen(false)}
        aria-label={tx("Show more")}
      >
        <div className={styles.moreList}>
          {hidden.map((i) => (
            <div key={i.id} className={styles.moreRow}>
              <span className={styles.moreLabel}>
                {i.title && (i.id.startsWith("plugin.") ? i.title : <T>{i.title}</T>)}
              </span>
              <div ref={slot(popupSlots, i.id)} className={styles.slot} />
            </div>
          ))}
        </div>
      </Popup>
      {shownRight.map((i) => {
        const C = i.component;
        return createPortal(
          <ErrorBoundary name={`status item ${i.id}`}>
            <C />
          </ErrorBoundary>,
          host(i.id),
          i.id,
        );
      })}
    </footer>
  );
}

/** Built-in: the transient status message (`showStatusInfo`). */
export function StatusInfo() {
  const text = useStatusInfo((s) => s.text);
  if (!text) return null;
  return (
    <span className={styles.info} role="status" title={text}>
      {text}
    </span>
  );
}

/** A task's cancel button: working, "Cancelling…", or disabled with the reason it can't be stopped. */
function TaskCancel({ task: t }: { task: BackgroundTask }) {
  if (t.done) return null;
  if (canCancel(t))
    return <IconButton icon="stop" size="small" title={tx`Cancel ${t.title}`} onClick={() => cancelTask(t.id)} />;
  const reason = t.cancelling ? tx("Cancelling…") : t.uncancellable;
  if (!reason) return null;
  // A disabled button gets no pointer events; the wrapper shows why.
  return (
    <span className={styles.taskCancelOff} {...tooltipAttrs(reason)}>
      <IconButton icon="stop" size="small" title={reason} disabled />
    </span>
  );
}

const useTaskPopup = create<{ open: boolean }>(() => ({ open: false }));

export function showBackgroundTasks() {
  useTaskPopup.setState({ open: true });
}

/** Built-in: background task progress; click lists all running tasks. */
export function TaskStatus() {
  const tasks = useTasks((s) => s.tasks);
  const open = useTaskPopup((s) => s.open);
  const running = tasks.filter((t) => !t.done);
  // A task that is working wins over the queued ones waiting behind it.
  const current = running.findLast((t) => !t.queued) ?? running[running.length - 1] ?? tasks[tasks.length - 1];
  if (!current) return null;
  const more = running.length - 1;
  return (
    <>
      <BarButton
        data-background-tasks
        aria-expanded={open}
        aria-label={tx`Background tasks: ${current.title}`}
        tooltip={current.message ?? current.title}
        onClick={() => useTaskPopup.setState({ open: !open })}
        className={styles.task}
      >
        <span className={styles.taskTitle}>
          <T>{current.title}</T>
        </span>
        <ProgressBar
          value={current.done ? 1 : current.fraction}
          className={styles.taskBar}
          aria-label={current.title}
        />
        {more > 0 && <span className={styles.taskMore}>+{more}</span>}
      </BarButton>
    </>
  );
}

export function BackgroundTasksHost() {
  const open = useTaskPopup((s) => s.open);
  const tasks = useTasks((s) => s.tasks);
  // The last task ending (or cancelled from here) closes the popup: its status bar anchor goes away.
  const hadTasks = useRef(tasks.length > 0);
  useLayoutEffect(() => {
    if (hadTasks.current && !tasks.length) useTaskPopup.setState({ open: false });
    hadTasks.current = tasks.length > 0;
  }, [tasks.length]);
  const anchor = (tasks.length ? document.querySelector("[data-background-tasks]") : null) ?? {
    x: window.innerWidth - 16,
    y: window.innerHeight - 16,
  };
  return (
    <Popup
      open={open}
      anchor={anchor}
      placement="top-end"
      offset={6}
      onClose={() => useTaskPopup.setState({ open: false })}
      aria-label="Background tasks"
    >
      <div className={styles.taskList}>
        <div className={styles.taskListHeader}>
          <T>Background Tasks</T>
        </div>
        {tasks.length === 0 && (
          <div className={styles.taskRow}>
            <T>No background tasks</T>
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className={styles.taskRow}>
            <div className={styles.taskRowHead}>
              <span className={styles.taskRowTitle}>
                <T>{t.title}</T>
              </span>
              {t.fraction != null && <span className={styles.taskPct}>{Math.round(t.fraction * 100)}%</span>}
              <TaskCancel task={t} />
            </div>
            <ProgressBar value={t.done ? 1 : t.fraction} aria-label={t.title} />
            {t.message && <div className={styles.taskMessage}>{t.message}</div>}
          </div>
        ))}
      </div>
    </Popup>
  );
}
