import clsx from "clsx";
import styles from "../GitLog.module.css";
import { useColumnResize, type ResizeTarget } from "./useColumnResize";

/** Full-height resize strip on a data-row cell (IDEA's column divider). */
export function RowResizeHandle({ target }: { target: ResizeTarget }) {
  const resize = useColumnResize(target);
  return <span className={clsx(styles.columnResize, styles.columnResizeRow)} aria-hidden="true" {...resize} />;
}
