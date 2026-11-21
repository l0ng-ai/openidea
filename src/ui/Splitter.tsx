/**
 * Thin wrappers over react-resizable-panels with IDE styling: 1px hairline
 * separators with a wider invisible hit area and an accent hover state.
 */
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";
import clsx from "clsx";
import { createContext, useContext, useEffect, useImperativeHandle, useRef, useState } from "react";
import styles from "./Splitter.module.css";

const SplitResetContext = createContext<((handle: HTMLElement, defaultHandled: boolean) => void) | null>(null);

function savedLayout(storageKey: string | undefined): Record<string, number> | undefined {
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
}

/**
 * `storageKey` remembers the sizes the user drags to. A group whose panels come and go (a
 * preview pane) passes a key per panel set; when it changes, the saved or default sizes are applied.
 */
export function SplitGroup({
  className,
  storageKey,
  defaultLayout,
  onLayoutChanged,
  groupRef,
  ...rest
}: GroupProps & { storageKey?: string }) {
  const [saved] = useState(() => savedLayout(storageKey));
  const group = useRef<GroupImperativeHandle | null>(null);
  const mountedKey = useRef(storageKey);
  // Sizes to apply once the group's panels match them (a panel added with the new key registers later).
  const pending = useRef<Record<string, number> | null>(null);
  const saveLayout = (layout: Record<string, number>) => {
    if (!storageKey || !Object.values(layout).every(Number.isFinite)) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch {
      /* Storage may be unavailable. */
    }
  };
  const applyPending = (current: Record<string, number>) => {
    const layout = pending.current;
    if (!layout) return;
    const ids = Object.keys(current);
    if (ids.length !== Object.keys(layout).length || !ids.every((id) => id in layout)) return;
    pending.current = null;
    group.current?.setLayout(layout);
  };
  useEffect(() => {
    if (storageKey === mountedKey.current) return;
    mountedKey.current = storageKey;
    pending.current = storageKey ? (savedLayout(storageKey) ?? defaultLayout ?? null) : null;
    const current = group.current?.getLayout();
    if (current) applyPending(current);
  }, [storageKey, defaultLayout]);
  useImperativeHandle(
    groupRef,
    () => ({
      getLayout: () => group.current?.getLayout() ?? {},
      setLayout: (layout) => group.current?.setLayout(layout) ?? layout,
    }),
    [],
  );
  const onLayoutChange: GroupProps["onLayoutChange"] = (layout) => {
    applyPending(layout);
    rest.onLayoutChange?.(layout);
  };
  const resetHandle = (handle: HTMLElement, defaultHandled: boolean) => {
    const g = group.current;
    if (!g || rest.disabled) return;
    if (!defaultHandled) {
      let prev = handle.previousElementSibling;
      while (prev && !prev.hasAttribute("data-panel")) prev = prev.previousElementSibling;
      let next = handle.nextElementSibling;
      while (next && !next.hasAttribute("data-panel")) next = next.nextElementSibling;
      const current = g.getLayout();
      const left = prev?.id ? current[prev.id] : undefined;
      const right = next?.id ? current[next.id] : undefined;
      if (prev?.id && next?.id && left !== undefined && right !== undefined) {
        const half = (left + right) / 2;
        g.setLayout({ ...current, [prev.id]: half, [next.id]: half });
      }
    }
    const updated = g.getLayout();
    if (Object.keys(updated).length) saveLayout(updated);
  };
  return (
    <SplitResetContext.Provider value={resetHandle}>
      <Group
        className={clsx(styles.group, className)}
        {...rest}
        groupRef={group}
        onLayoutChange={onLayoutChange}
        defaultLayout={storageKey ? (saved ?? defaultLayout) : defaultLayout}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction) saveLayout(meta.requestedLayout ?? layout);
          onLayoutChanged?.(layout, meta);
        }}
      />
    </SplitResetContext.Provider>
  );
}

export function SplitPanel({ className, ...rest }: PanelProps) {
  return <Panel className={clsx(styles.panel, className)} {...rest} />;
}

export interface SplitHandleProps extends SeparatorProps {
  /** `false`: no visible line (neighbouring panels draw their own borders); only the hit area remains. */
  hairline?: boolean;
}

export function SplitHandle({ className, hairline = true, onDoubleClick, ...rest }: SplitHandleProps) {
  const reset = useContext(SplitResetContext);
  return (
    <Separator
      className={clsx(styles.handle, !hairline && styles.invisible, className)}
      onDoubleClick={(e) => {
        onDoubleClick?.(e);
        if (!rest.disabled && !rest.disableDoubleClick) reset?.(e.currentTarget, e.defaultPrevented);
      }}
      {...rest}
    />
  );
}
