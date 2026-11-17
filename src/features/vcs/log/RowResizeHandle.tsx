import styles from "../GitLog.module.css";
import { useColumnResize } from "./useColumnResize";

/** Full-height, invisible resize strip on a data-row cell (IDEA's column divider). */
export function RowResizeHandle({ id, width }: { id: string; width: number }) {
  const resize = useColumnResize(id, width);
  return <span className={styles.columnResize} aria-hidden="true" {...resize} />;
}
