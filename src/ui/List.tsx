/**
 * Virtualized list with keyboard navigation and non-selectable section
 * headers (Search Everywhere's "Classes / Symbols / Actions"). Navigation can
 * also be driven from an external input via `listNavigate`, so focus can stay
 * in a search field while ↑/↓ move the selection.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { rowSelectionMode } from "./rowSelection";
import styles from "./List.module.css";

export interface ListRowState {
  active: boolean;
  index: number;
}

export interface ListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, state: ListRowState) => ReactNode;
  isSection?: (item: T) => boolean;
  renderSection?: (item: T) => ReactNode;
  activeIndex?: number;
  defaultActiveIndex?: number;
  onActiveChange?: (index: number) => void;
  /** Opt into modifier selection; modified clicks select without activating. */
  onSelect?: (index: number, e: KeyboardEvent | MouseEvent) => void;
  /** Rows selected besides the active one (multi-selection); drawn like the active row. */
  isSelected?: (item: T, index: number) => boolean;
  onActivate?: (item: T, index: number, e: KeyboardEvent | MouseEvent) => void;
  onContextMenu?: (item: T, index: number, e: MouseEvent) => void;
  rowHeight?: number;
  sectionHeight?: number;
  /** Height of a given section row (e.g. thin separators), else `sectionHeight`. */
  sectionHeightOf?: (item: T) => number | undefined;
  /** `false` when an external input drives navigation (rows still respond to the mouse). */
  focusable?: boolean;
  /** Move the active row with the pointer (popup choosers). */
  hoverSelects?: boolean;
  empty?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  overscan?: number;
}

const isSelectable = <T,>(items: readonly T[], i: number, isSection?: (item: T) => boolean) =>
  i >= 0 && i < items.length && !(isSection?.(items[i]!) ?? false);

/**
 * Computes the next active index for a navigation key, or `null` if the key
 * isn't a list navigation key. Skips section rows; doesn't wrap at the ends
 * except for ↑/↓ when `wrap` is set.
 */
export function listNavigate<T>(
  key: string,
  opts: { items: readonly T[]; active: number; isSection?: (item: T) => boolean; pageSize?: number; wrap?: boolean },
): number | null {
  const { items, active, isSection, pageSize = 10, wrap = false } = opts;
  const n = items.length;
  if (!n) return null;
  const sel = (i: number) => isSelectable(items, i, isSection);
  const scan = (from: number, dir: 1 | -1) => {
    for (let i = from; i >= 0 && i < n; i += dir) if (sel(i)) return i;
    return -1;
  };
  let next: number;
  switch (key) {
    case "ArrowDown":
      next = scan(active + 1, 1);
      if (next < 0 && wrap) next = scan(0, 1);
      break;
    case "ArrowUp":
      next = active < 0 ? scan(n - 1, -1) : scan(active - 1, -1);
      if (next < 0 && wrap) next = scan(n - 1, -1);
      break;
    case "Home":
      next = scan(0, 1);
      break;
    case "End":
      next = scan(n - 1, -1);
      break;
    case "PageDown":
      next = scan(Math.min(n - 1, active + pageSize), -1);
      if (next <= active) next = scan(active + 1, 1);
      break;
    case "PageUp":
      next = scan(Math.max(0, active - pageSize), 1);
      if (next >= active || next < 0) next = scan(active - 1, -1);
      break;
    default:
      return null;
  }
  return next < 0 ? active : next;
}

export function firstSelectable<T>(items: readonly T[], isSection?: (item: T) => boolean): number {
  for (let i = 0; i < items.length; i++) if (isSelectable(items, i, isSection)) return i;
  return -1;
}

export function List<T>({
  items,
  getKey,
  renderItem,
  isSection,
  renderSection,
  activeIndex,
  defaultActiveIndex,
  onActiveChange,
  onSelect,
  isSelected,
  onActivate,
  onContextMenu,
  rowHeight = 24,
  sectionHeight = 24,
  sectionHeightOf,
  focusable = true,
  hoverSelects = false,
  empty,
  className,
  overscan = 8,
  ...aria
}: ListProps<T>) {
  const [innerActive, setInnerActive] = useState(() => defaultActiveIndex ?? firstSelectable(items, isSection));
  const active = activeIndex ?? innerActive;
  const setActive = (i: number) => {
    if (activeIndex === undefined) setInnerActive(i);
    onActiveChange?.(i);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (isSection?.(items[i]!) ? (sectionHeightOf?.(items[i]!) ?? sectionHeight) : rowHeight),
    overscan,
    getItemKey: (i) => getKey(items[i]!, i),
  });

  useEffect(() => {
    if (active >= 0 && active < items.length) virtualizer.scrollToIndex(active, { align: "auto" });
  }, [active, items.length, virtualizer]);

  // Options are virtualised: expose position / count of selectable rows to assistive tech.
  const optionIndex = useMemo(() => {
    const idx: number[] = [];
    let n = 0;
    for (const item of items) idx.push(isSection?.(item) ? 0 : ++n);
    return { idx, count: n };
  }, [items, isSection]);

  const pageSize = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 240) / rowHeight) - 1);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (isSelectable(items, active, isSection)) {
        e.preventDefault();
        onActivate?.(items[active]!, active, e);
      }
      return;
    }
    const next = listNavigate(e.key, { items, active, isSection, pageSize });
    if (next === null) return;
    e.preventDefault();
    if (onSelect) onSelect(next, e);
    else if (next !== active) setActive(next);
  };

  if (!items.length && empty) return <div className={clsx(styles.list, styles.emptyWrap, className)}>{empty}</div>;

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-multiselectable={onSelect ? true : undefined}
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      aria-activedescendant={
        focusable && active >= 0 && virtualizer.getVirtualItems().some((v) => v.index === active)
          ? `${baseId}-${active}`
          : undefined
      }
      tabIndex={focusable ? 0 : -1}
      className={clsx(styles.list, className)}
      onKeyDown={focusable ? onKeyDown : undefined}
    >
      <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index]!;
          const section = isSection?.(item) ?? false;
          const style = { transform: `translateY(${v.start}px)`, height: v.size };
          if (section) {
            return (
              <div key={v.key} role="presentation" className={styles.section} style={style}>
                {renderSection ? renderSection(item) : String(item)}
              </div>
            );
          }
          const isActive = v.index === active;
          const selected = isActive || (isSelected?.(item, v.index) ?? false);
          return (
            <div
              key={v.key}
              id={`${baseId}-${v.index}`}
              role="option"
              aria-selected={selected}
              data-lead={isActive || undefined}
              aria-posinset={optionIndex.idx[v.index]}
              aria-setsize={optionIndex.count}
              className={clsx(styles.row, selected && styles.active)}
              style={style}
              onPointerMove={hoverSelects && !isActive ? () => setActive(v.index) : undefined}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                if (!focusable) e.preventDefault();
                if (!onSelect) setActive(v.index);
              }}
              onClick={(e) => {
                onSelect?.(v.index, e);
                if (!onSelect || rowSelectionMode(e) === "single") onActivate?.(item, v.index, e);
              }}
              onContextMenu={onContextMenu ? (e) => onContextMenu(item, v.index, e) : undefined}
            >
              {renderItem(item, { active: isActive, index: v.index })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
