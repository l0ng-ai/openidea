import { tx } from "@/platform/i18n";
import { showContextMenu } from "@/ui";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../GitLog.module.css";
import { type LogOptions } from "../logOptions";
import { updateLogOptions } from "../logStore";
import { useVcs } from "../store";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { SUBJECT_COLUMN, columnSequence, type LogColumn } from "./shared";
import { columnPrev, resetColumnWidth, type ResizeTarget } from "./useColumnResize";

interface ColumnDrag {
  id: string;
  target: string | null;
  after: boolean;
}

/** Fixed columns that can be hidden from the header context menu. */
const HIDDEN_COLUMN_OPTION: Record<string, keyof LogOptions> = {
  author: "showAuthor",
  date: "showDate",
  hash: "showHash",
  signature: "showSignature",
  "github-checks": "showGitHubChecks",
  repository: "showRepository",
};

export function ColumnHeaders({
  columns,
  options,
  minWidth,
}: {
  columns: LogColumn[];
  options: LogOptions;
  minWidth: number;
}) {
  const [drag, setDrag] = useState<ColumnDrag | null>(null);
  const ids = columnSequence(options.columnOrder, columns);
  const cancel = useCallback(() => setDrag(null), []);
  const move = (source: string, target: string | null, after: boolean) => {
    if (!target || source === target || !ids.includes(source) || !ids.includes(target)) return;
    const reordered = ids.filter((id) => id !== source);
    const to = reordered.indexOf(target);
    reordered.splice(after ? to + 1 : to, 0, source);
    updateLogOptions({ columnOrder: reordered });
  };
  const visibleIds = ids.filter((id) => id === SUBJECT_COLUMN.id || columns.some((column) => column.id === id));
  return (
    <div
      className={clsx(styles.row, styles.columnHeader, options.showColumnDividers && styles.showDividers)}
      style={{ minWidth }}
    >
      {options.showRepository && useVcs.getState().roots.length > 1 && (
        <span className={styles.colRepository}>{tx("Repository")}</span>
      )}
      {ids.map((cid) => {
        const column = cid === SUBJECT_COLUMN.id ? SUBJECT_COLUMN : columns.find((c) => c.id === cid);
        if (!column) return null;
        return (
          <LogColumnHeader
            key={cid}
            column={column}
            subject={cid === SUBJECT_COLUMN.id}
            ids={visibleIds}
            options={options}
            columns={columns}
            drag={drag}
            onMove={move}
            onDragOver={(id, target, after) =>
              setDrag((d) => (d?.id === id && d.target === target && d.after === after ? d : { id, target, after }))
            }
            onDragCancel={cancel}
          />
        );
      })}
    </div>
  );
}

// Column headers reorder by pointer capture: WebView2 blocks HTML5 drag events
// while dragDropEnabled is on, so dragging must not rely on them.
function LogColumnHeader({
  column,
  subject,
  ids,
  options,
  columns,
  drag,
  onMove,
  onDragOver,
  onDragCancel,
}: {
  column: LogColumn;
  subject?: boolean;
  ids: string[];
  options: LogOptions;
  columns: LogColumn[];
  drag: ColumnDrag | null;
  onMove(source: string, target: string | null, after: boolean): void;
  onDragOver(id: string, target: string | null, after: boolean): void;
  onDragCancel(): void;
}) {
  const press = useRef<{
    x: number;
    y: number;
    active: boolean;
    element: HTMLElement;
    pointerId: number;
  } | null>(null);
  const cancel = useCallback(() => {
    const capture = press.current;
    press.current = null;
    if (capture?.element.hasPointerCapture?.(capture.pointerId))
      capture.element.releasePointerCapture(capture.pointerId);
    onDragCancel();
  }, [onDragCancel]);
  useEffect(() => {
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !press.current) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      cancel();
    };
  }, [cancel]);
  const width = options.columnWidths[column.id] ?? column.width ?? 120;
  const resizeTarget: ResizeTarget = {
    id: column.id,
    width,
    ...columnPrev(ids, column.id, options, columns),
    // Commit is flex:1 — dragging its left divider only resizes the left neighbour.
    leftOnly: subject || undefined,
  };
  const index = ids.indexOf(column.id);
  const isFirst = index === 0;
  const hitColumn = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest?.("[data-log-column]");
    if (!el || el.parentElement !== press.current?.element.parentElement) return null;
    const rect = el.getBoundingClientRect();
    return { id: el.getAttribute("data-log-column")!, after: x > rect.left + rect.width / 2 };
  };
  return (
    <span
      className={clsx(
        styles.columnCell,
        styles.columnHeading,
        subject && styles.colSubject,
        drag?.id === column.id && styles.dragSource,
        drag &&
          drag.target === column.id &&
          drag.id !== column.id &&
          (drag.after ? styles.dropAfter : styles.dropBefore),
      )}
      style={subject ? undefined : { width }}
      data-log-column={column.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        press.current = { x: e.clientX, y: e.clientY, active: false, element: e.currentTarget, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const start = press.current;
        if (!start || start.pointerId !== e.pointerId) return;
        if (!start.active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
        start.active = true;
        const target = hitColumn(e.clientX, e.clientY);
        onDragOver(column.id, target?.id ?? null, target?.after ?? false);
      }}
      onPointerUp={(e) => {
        const start = press.current;
        if (!start || start.pointerId !== e.pointerId) return;
        const target = hitColumn(e.clientX, e.clientY);
        if (start.active) onMove(column.id, target?.id ?? null, target?.after ?? false);
        cancel();
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, [
          {
            label: "Move Left",
            disabled: index === 0,
            run: () => onMove(column.id, ids[index - 1] ?? null, false),
          },
          {
            label: "Move Right",
            disabled: index === ids.length - 1,
            run: () => onMove(column.id, ids[index + 1] ?? null, true),
          },
          ...(subject
            ? []
            : [
                { label: "Reset Width", run: () => resetColumnWidth(column.id) },
                { kind: "separator" as const },
                {
                  label: tx("Hide Column"),
                  run: () => {
                    const key = HIDDEN_COLUMN_OPTION[column.id];
                    if (key) updateLogOptions({ [key]: false });
                  },
                },
              ]),
        ]);
      }}
    >
      {tx(column.title)}
      {subject ? (
        // Commit's left divider exists only in the header. It is decorative when
        // Commit is the first column; otherwise it resizes the neighbour on its left.
        <ColumnResizeHandle target={resizeTarget} title={column.title} disabled={isFirst} />
      ) : (
        <ColumnResizeHandle
          target={resizeTarget}
          title={column.title}
          onReorder={(delta) => onMove(column.id, ids[index + delta] ?? null, delta === 1)}
        />
      )}
    </span>
  );
}
