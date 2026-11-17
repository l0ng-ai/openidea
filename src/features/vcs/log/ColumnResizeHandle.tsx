import { tx } from "@/platform/i18n";
import clsx from "clsx";
import styles from "../GitLog.module.css";
import { resizeColumnPair, useColumnResize, type ResizeTarget } from "./useColumnResize";

/**
 * Column divider on the column's left edge. A visible rule marks the grab target;
 * hovering brightens it. Keyboard users get a focusable separator whose Left/Right
 * arrows resize the adjacent pair (Alt+Left/Right reorders, header only).
 *
 * `disabled` renders the rule without any resize interaction — used for the
 * first column's left border, which has no neighbour to give/take space.
 */
export function ColumnResizeHandle({
  target,
  title,
  onReorder,
  disabled,
}: {
  target: ResizeTarget;
  title: string;
  onReorder?: (delta: number) => void;
  disabled?: boolean;
}) {
  const resize = useColumnResize(target);
  return (
    <span
      className={clsx(styles.columnResize, disabled && styles.columnResizeDisabled)}
      role="separator"
      aria-orientation="vertical"
      aria-label={disabled ? tx`${tx(title)} column border` : tx`Resize ${tx(title)} column`}
      aria-valuemin={40}
      aria-valuemax={800}
      aria-valuenow={target.width}
      tabIndex={disabled ? -1 : 0}
      {...(disabled ? {} : resize)}
      onKeyDown={(e) => {
        if (disabled || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
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
