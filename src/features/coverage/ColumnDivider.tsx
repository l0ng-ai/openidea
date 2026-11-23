import { useEffect, useRef } from "react";
import { tx, txPart } from "@/platform/i18n";
import { lockDragCursor } from "@/ui/dragCursor";
import styles from "./Coverage.module.css";

export function ColumnDivider({
  title,
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  title: string;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; width: number; pointerId: number; unlock: () => void } | null>(null);
  const stop = () => {
    drag.current?.unlock();
    drag.current = null;
  };
  useEffect(() => stop, []);

  const resize = (next: number) => {
    const fitted = Math.round(Math.max(min, Math.min(max, next)));
    if (fitted !== width) onResize(fitted);
  };

  return (
    <span
      className={styles.divider}
      role="separator"
      aria-orientation="vertical"
      aria-label={tx`Resize ${txPart(title)} column`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width, pointerId: event.pointerId, unlock: lockDragCursor("col-resize") };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX);
      }}
      onLostPointerCapture={stop}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        let next: number;
        switch (event.key) {
          case "ArrowLeft":
            next = width + 10;
            break;
          case "ArrowRight":
            next = width - 10;
            break;
          case "Home":
            next = min;
            break;
          case "End":
            next = max;
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        resize(next);
      }}
    />
  );
}
