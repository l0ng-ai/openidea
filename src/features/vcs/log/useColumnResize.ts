import { lockDragCursor } from "@/ui";
import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { logOptions } from "../logOptions";
import { updateLogOptions } from "../logStore";

const MIN_WIDTH = 40;
const MAX_WIDTH = 800;

export function resizeColumn(id: string, value: number) {
  updateLogOptions({
    columnWidths: { ...logOptions().columnWidths, [id]: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value)) },
  });
}

/** IDEA's double-click-on-divider behaviour: drop the custom width so the column fits its content again. */
export function resetColumnWidth(id: string) {
  const widths = { ...logOptions().columnWidths };
  delete widths[id];
  updateLogOptions({ columnWidths: widths });
}

type Drag = {
  x: number;
  width: number;
  element: HTMLElement;
  pointerId: number;
  releaseCursor: () => void;
};

/**
 * Pointer-driven column resize with an invisible, full-height hit strip (IDEA's
 * divider): hovering only changes the cursor, and dragging anywhere along the
 * boundary — header or data rows — resizes the column.
 */
export function useColumnResize(id: string, width: number) {
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
        x: e.clientX,
        width,
        element: e.currentTarget,
        pointerId: e.pointerId,
        releaseCursor: lockDragCursor("ew-resize"),
      };
      listeners.current = { blur, escape };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      window.addEventListener("blur", blur);
      window.addEventListener("keydown", escape, true);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (d && e.currentTarget.hasPointerCapture?.(e.pointerId)) resizeColumn(id, d.width + e.clientX - d.x);
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onMouseDown: (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation(),
    onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => {
      e.stopPropagation();
      resetColumnWidth(id);
    },
  };
}
