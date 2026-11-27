import clsx from "clsx";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import styles from "./Chip.module.css";

/** A read-only fact in a row of controls (the project, checkout and branch an agent works in). */
export function Chip({
  icon,
  children,
  title,
  className,
}: {
  icon?: IconName | (string & {});
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={clsx(styles.chip, className)} title={title}>
      {icon && <Icon name={icon} size={14} className={styles.icon} />}
      <span className={styles.label}>{children}</span>
    </span>
  );
}
