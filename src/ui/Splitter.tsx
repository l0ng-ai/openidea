/**
 * Thin wrappers over react-resizable-panels with IDE styling: 1px hairline
 * separators with a wider invisible hit area and an accent hover state.
 */
import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from "react-resizable-panels";
import clsx from "clsx";
import { useState } from "react";
import styles from "./Splitter.module.css";

export function SplitGroup({
  className,
  storageKey,
  defaultLayout,
  onLayoutChanged,
  ...rest
}: GroupProps & { storageKey?: string }) {
  const [saved] = useState(() => {
    try {
      const value: unknown = storageKey ? JSON.parse(localStorage.getItem(storageKey) ?? "null") : null;
      return value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100)
        ? (value as Record<string, number>)
        : undefined;
    } catch {
      return undefined;
    }
  });
  if (!storageKey)
    return (
      <Group
        className={clsx(styles.group, className)}
        {...rest}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      />
    );
  return (
    <Group
      className={clsx(styles.group, className)}
      {...rest}
      defaultLayout={saved ?? defaultLayout}
      onLayoutChanged={(layout, meta) => {
        if (storageKey && meta.isUserInteraction) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(meta.requestedLayout ?? layout));
          } catch {
            /* Storage may be unavailable. */
          }
        }
        onLayoutChanged?.(layout, meta);
      }}
    />
  );
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
