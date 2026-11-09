import type { ReactNode } from "react";
import clsx from "clsx";
import styles from "./InlineTag.module.css";

/** A text-sized tag that preserves glyph positions in mirrored inputs. */
export function InlineTag({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return <span className={clsx(styles.tag, accent && styles.accent)}>{children}</span>;
}
