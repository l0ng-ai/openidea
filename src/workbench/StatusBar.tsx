import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, IconButton, Popup, ProgressBar, showContextMenu, T } from "@/ui";
import { useContributions, useStatusInfo, type StatusItemContribution } from "./contributions";
import { ErrorBoundary } from "./ErrorBoundary";
import { isStatusItemVisible, statusBarMenu, useStatusWidgetOverrides } from "./statusBarWidgets";
import { useTasks } from "./tasks";
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

/** `lightEdit`: a LightEdit window's bar, with the items that apply there only. */
export function StatusBar({ lightEdit = false }: { lightEdit?: boolean }) {
  const map = useContributions((s) => s.statusItems);
  const overrides = useStatusWidgetOverrides();
  const { left, right } = useMemo(
    () => orderStatusItems([...map.values()].filter((i) => !lightEdit || i.lightEdit)),
    [map, lightEdit],
  );
  const visible = (i: StatusItemContribution) => isStatusItemVisible(i, overrides);
  const render = (item: StatusItemContribution) => {
    const C = item.component;
    const shrink = item.align === "left" || item.id === "workbench.tasks";
    return (
      <div key={item.id} className={clsx(styles.item, shrink && styles.shrink)} data-status-item={item.id}>
        <ErrorBoundary name={`status item ${item.id}`}>
          <C />
        </ErrorBoundary>
      </div>
    );
  };
  return (
    <footer
      className={styles.bar}
      aria-label={tx("Status bar")}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        showContextMenu(e, statusBarMenu([...left, ...right], overrides));
      }}
    >
      {left.filter(visible).map(render)}
      <div className={styles.spacer} />
      {right.filter(visible).map(render)}
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

/** Built-in: background task progress; click lists all running tasks. */
export function TaskStatus() {
  const tasks = useTasks((s) => s.tasks);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const running = tasks.filter((t) => !t.done);
  const current = running[running.length - 1] ?? tasks[tasks.length - 1];
  if (!current) return null;
  const more = running.length - 1;
  return (
    <>
      <BarButton
        ref={ref}
        aria-expanded={open}
        aria-label={tx`Background tasks: ${current.title}`}
        tooltip={current.message ?? current.title}
        onClick={() => setOpen((v) => !v)}
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
      <Popup
        open={open && tasks.length > 0}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={() => setOpen(false)}
        aria-label="Background tasks"
      >
        <div className={styles.taskList}>
          <div className={styles.taskListHeader}>
            <T>Background Tasks</T>
          </div>
          {tasks.map((t) => (
            <div key={t.id} className={styles.taskRow}>
              <div className={styles.taskRowHead}>
                <span className={styles.taskRowTitle}>
                  <T>{t.title}</T>
                </span>
                {t.fraction != null && <span className={styles.taskPct}>{Math.round(t.fraction * 100)}%</span>}
                {t.cancel && !t.done && (
                  <IconButton icon="stop" size="small" title={tx`Cancel ${t.title}`} onClick={() => t.cancel?.()} />
                )}
              </div>
              <ProgressBar value={t.done ? 1 : t.fraction} aria-label={t.title} />
              {t.message && <div className={styles.taskMessage}>{t.message}</div>}
            </div>
          ))}
        </div>
      </Popup>
    </>
  );
}
