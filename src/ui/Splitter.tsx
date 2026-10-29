/**
 * Thin wrappers over react-resizable-panels with IDE styling: 1px hairline
 * separators with a wider invisible hit area and an accent hover state.
 */
import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from "react-resizable-panels";
import clsx from "clsx";
import styles from "./Splitter.module.css";

export function SplitGroup({ className, ...rest }: GroupProps) {
  return <Group className={clsx(styles.group, className)} {...rest} />;
}

export function SplitPanel({ className, ...rest }: PanelProps) {
  return <Panel className={clsx(styles.panel, className)} {...rest} />;
}

export interface SplitHandleProps extends SeparatorProps {
  /** `false`: no visible line (neighbouring panels draw their own borders); only the hit area remains. */
  hairline?: boolean;
}

export function SplitHandle({ className, hairline = true, ...rest }: SplitHandleProps) {
  return <Separator className={clsx(styles.handle, !hairline && styles.invisible, className)} {...rest} />;
}
