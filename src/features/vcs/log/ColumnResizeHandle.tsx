import { tx } from "@/platform/i18n";
import styles from "../GitLog.module.css";
import { resizeColumn, useColumnResize } from "./useColumnResize";

/**
 * Invisible full-height divider. Hovering shows only the resize cursor; the strip
 * itself paints nothing (IDEA's table divider). Keyboard users still get a focusable
 * separator: Left/Right adjusts width, Alt+Left/Right reorders (header only).
 */
export function ColumnResizeHandle({
  id,
  title,
  width,
  onReorder,
}: {
  id: string;
  title: string;
  width: number;
  onReorder?: (delta: number) => void;
}) {
  const resize = useColumnResize(id, width);
  return (
    <span
      className={styles.columnResize}
      role="separator"
      aria-orientation="vertical"
      aria-label={tx`Resize ${tx(title)} column`}
      aria-valuemin={40}
      aria-valuemax={800}
      aria-valuenow={width}
      tabIndex={0}
      {...resize}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "ArrowLeft" ? -1 : 1;
        if (e.altKey && onReorder) onReorder(delta);
        else resizeColumn(id, width + delta * 10);
      }}
    />
  );
}
