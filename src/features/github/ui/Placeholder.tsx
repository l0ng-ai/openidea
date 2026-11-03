/** The marked placeholder of a part of the port that is not built yet (foundation stubs). */
import type { ReactNode } from "react";
import { T } from "@/ui";
import styles from "./ui.module.css";

export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.placeholder} data-placeholder={title}>
      <div className={styles.placeholderTitle}>
        <T>{title}</T>
      </div>
      {children}
    </div>
  );
}
