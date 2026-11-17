import { tx } from "@/platform/i18n";
import styles from "../GitLog.module.css";
import { resizeColumnPair, useColumnResize, type ResizeTarget } from "./useColumnResize";

/**
 * Column divider on the column's left edge. A visible rule marks the grab target;
 * hovering brightens it. Keyboard users get a focusable separator whose Left/Right
 * arrows resize the adjacent pair (Alt+Left/Right reorders, header only).
 */
export function ColumnResizeHandle({
  target,
  title,
  onReorder,
}: {
  target: ResizeTarget;
  title: string;
  onReorder?: (delta: number) => void;
}) {
  const resize = useColumnResize(target);
  return (
    <span
      className={styles.columnResize}
      role="separator"
      aria-orientation="vertical"
      aria-label={tx`Resize ${tx(title)} column`}
      aria-valuemin={40}
      aria-valuemax={800}
      aria-valuenow={target.width}
      tabIndex={0}
      {...resize}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "ArrowLeft" ? -1 : 1;
        if (e.altKey && onReorder) onReorder(delta);
        // Handle is on the left edge: Left arrow widens this column.
        // resizeColumnPair takes positive = widen, so invert the arrow delta.
        else resizeColumnPair(target, -delta * 10);
      }}
    />
  );
}
