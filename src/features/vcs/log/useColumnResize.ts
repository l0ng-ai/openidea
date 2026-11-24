import { lockDragCursor } from "@/ui";
import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { logOptions, type LogOptions } from "../logOptions";
import { updateLogOptions } from "../logStore";
import { SUBJECT_COLUMN, type LogColumn } from "./shared";

const MIN_WIDTH = 40;
const MAX_WIDTH = 800;
const clamp = (value: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));

export type ResizeTarget = {
  id: string;
  width: number;
  /** Column to the left of this divider, or null when this is the first column. */
  prevId: string | null;
  prevWidth: number;
  /** True for the flexible Commit column: only the left neighbour gets a stored width. */
  leftOnly?: boolean;
};

/** Resolve the column immediately left of `id` in the visible order. */
export function columnPrev(
  ids: string[],
  id: string,
  options: LogOptions,
  columns: LogColumn[],
): { prevId: string | null; prevWidth: number } {
  const index = ids.indexOf(id);
  const prevId = index > 0 ? ids[index - 1] : null;
  // The Commit column is flex:1 and absorbs space on its own — never store a width for it.
  // (When *we are* the Commit column the caller handles the left neighbour via leftOnly,
  // so this guard only applies to fixed columns whose left neighbour is Commit.)
  if (!prevId || (prevId === SUBJECT_COLUMN.id && id !== SUBJECT_COLUMN.id)) return { prevId: null, prevWidth: 0 };
  const prev = columns.find((c) => c.id === prevId);
  // subject has no fixed width of its own; its "prevWidth" is unused in leftOnly mode.
  return { prevId, prevWidth: options.columnWidths[prevId] ?? prev?.width ?? 120 };
}

/**
 * Resize the divider between `id` (right) and `prevId` (left): only these two
 * columns give/take space, so every other column stays put. When the left neighbour
 * is the flexible Commit column, only the right column's width is stored (Commit
 * absorbs the rest through flex:1).
 */
export function resizeColumnPair(target: ResizeTarget, delta: number) {
  const { id, width, prevId, prevWidth, leftOnly } = target;
  const widths = { ...logOptions().columnWidths };
  if (prevId == null) {
    // First column with no left neighbour (should be non-resizable at the UI layer).
    widths[id] = clamp(width + delta);
  } else if (leftOnly) {
    // The Commit column is flex:1. The handle sits on the boundary (the left
    // neighbour's right edge), so the divider follows the pointer: dragging right
    // widens the left neighbour and shrinks Commit. `delta` is already -dx, so
    // subtracting it makes the neighbour track dx exactly.
    widths[prevId] = clamp(prevWidth - delta);
  } else {
    const left = clamp(prevWidth - delta);
    const given = prevWidth - left; // what the left column actually gave up
    widths[id] = clamp(width + given);
    widths[prevId] = left;
  }
  updateLogOptions({ columnWidths: widths });
}

/** IDEA's double-click-on-divider behaviour: drop the custom width so the column fits its content again. */
export function resetColumnWidth(id: string) {
  const widths = { ...logOptions().columnWidths };
  delete widths[id];
  updateLogOptions({ columnWidths: widths });
}

type Drag = ResizeTarget & {
  x: number;
  element: HTMLElement;
  pointerId: number;
  releaseCursor: () => void;
};

/**
 * Pointer-driven column resize with a full-height hit strip on the column's left
 * edge. Dragging left widens the column (and narrows only its left neighbour);
 * the divider follows the pointer 1:1.
 */
export function useColumnResize(target: ResizeTarget) {
  const drag = useRef<Drag | null>(null);
  // Listeners are attached imperatively so `cancel` is defined before it is referenced.
  const listeners = useRef<{ blur: () => void; escape: (e: KeyboardEvent) => void } | null>(null);
  const cancel = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.releaseCursor();
    drag.current = null;
    if (d.element.hasPointerCapture?.(d.pointerId)) d.element.releasePointerCapture(d.pointerId);
    if (listeners.current) {
      window.removeEventListener("blur", listeners.current.blur);
      window.removeEventListener("keydown", listeners.current.escape, true);
      listeners.current = null;
    }
  }, []);
  useEffect(() => () => cancel(), [cancel]);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || drag.current) return;
      // Suppress the compatibility mousedown so a data-row strip doesn't select the row.
      e.preventDefault();
      e.stopPropagation();
      const blur = () => cancel();
      const escape = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") cancel();
      };
      drag.current = {
        ...target,
        x: e.clientX,
        element: e.currentTarget,
        pointerId: e.pointerId,
        releaseCursor: lockDragCursor("col-resize"),
      };
      listeners.current = { blur, escape };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      window.addEventListener("blur", blur);
      window.addEventListener("keydown", escape, true);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      // Handle is on the left edge: drag left -> wider.
      if (d && e.currentTarget.hasPointerCapture?.(e.pointerId)) resizeColumnPair(d, -(e.clientX - d.x));
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onMouseDown: (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation(),
    onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => {
      e.stopPropagation();
      resetColumnWidth(target.id);
    },
  };
}
