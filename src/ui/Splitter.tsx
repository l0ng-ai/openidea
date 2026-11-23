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
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useFormFactor } from "@/platform/formFactor";
import { tx } from "@/platform/i18n";
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
  const phone = useFormFactor((s) => s.formFactor === "phone");
  if (phone && (rest.orientation ?? "horizontal") === "horizontal") {
    return <PhoneSplit className={clsx(styles.group, className)}>{rest.children}</PhoneSplit>;
  }
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

export interface SplitPanelProps extends PanelProps {
  /** The panel's name where panels take turns (a phone): defaults to its `id`, capitalised. */
  title?: string;
}

export function SplitPanel({ className, title: _title, ...rest }: SplitPanelProps) {
  return <Panel className={clsx(styles.panel, className)} {...rest} />;
}

/** The `SplitPanel`s among `children`, through fragments and conditionals. */
function panelsOf(children: ReactNode): ReactElement<SplitPanelProps>[] {
  const out: ReactElement<SplitPanelProps>[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) out.push(...panelsOf((child.props as { children?: ReactNode }).children));
    // By name rather than identity: a hot-reloaded module has a new `SplitPanel`.
    else if (typeof child.type === "function" && child.type.name === SplitPanel.name)
      out.push(child as ReactElement<SplitPanelProps>);
  });
  return out;
}

function panelTitle(p: SplitPanelProps, index: number): string {
  if (p.title) return tx(p.title);
  const id = p.id ?? `${index + 1}`;
  return tx(id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, " "));
}

/**
 * Side-by-side panels on a phone: one at a time, the others a tab away. Choosing an item in a
 * list (a branch, a commit) goes on to the next panel, as a phone's list → detail screens do.
 */
function PhoneSplit({ className, children }: { className?: string; children?: ReactNode }) {
  const panels = panelsOf(children);
  const [active, setActive] = useState(0);
  const shown = Math.min(active, Math.max(0, panels.length - 1));
  const advance = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const item = target?.closest('[role="option"], [role="treeitem"], [role="row"]');
    if (!item || item.hasAttribute("aria-expanded")) return;
    if (target?.closest("button, input, textarea, select, a, [contenteditable]")) return;
    // After the list's own click handling has selected the item.
    window.setTimeout(() => setActive(shown + 1), 0);
  };
  return (
    <div className={clsx(className, styles.phoneSplit)}>
      {panels.length > 1 && (
        <div role="tablist" className={styles.phoneTabs}>
          {panels.map((p, i) => (
            <button
              key={p.props.id ?? i}
              type="button"
              role="tab"
              aria-selected={i === shown}
              className={styles.phoneTab}
              onClick={() => setActive(i)}
            >
              {panelTitle(p.props, i)}
            </button>
          ))}
        </div>
      )}
      {panels.map((p, i) => (
        <div
          key={p.props.id ?? i}
          className={clsx(styles.phonePanel, p.props.className)}
          style={p.props.style}
          hidden={i !== shown}
          onClick={i === shown && i < panels.length - 1 ? advance : undefined}
        >
          {p.props.children}
        </div>
      ))}
    </div>
  );
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
