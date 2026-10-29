/**
 * Virtualized tree with lazy children, multi-selection, IDEA keyboard model
 * (↑↓←→, Enter / F4 / ⌘↓, Home/End, PageUp/PageDown, Shift-extend) and speed
 * search: typing while the tree is focused highlights matches and jumps to them
 * (↑/↓ cycle matches, Home/End first / last match, Esc clears; ←/→, Enter and
 * PageUp/PageDown close it and act as usual); `speedSearchMode="filter"` hides
 * rows that neither match nor contain a match.
 */
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon, type IconName } from "./icons";
import { HighlightedText } from "./HighlightedText";
import { Spinner } from "./Feedback";
import { fuzzyMatch } from "./match";
import { acquirePopup } from "./popupState";
import styles from "./Tree.module.css";
import { T } from "./T";
import { tx } from "@/platform/i18n";

export interface TreeRowState {
  depth: number;
  expanded: boolean;
  expandable: boolean;
  selected: boolean;
  /** Keyboard lead row. */
  lead: boolean;
  /** Speed search match indices into the label, if matching. */
  matches: number[] | null;
}

/** Where Next / Previous Occurrence landed: the selected node and its 1-based position among all occurrences. */
export interface TreeOccurrence {
  key: string;
  node: unknown;
  index: number;
  total: number;
}

export interface TreeHandle {
  focus(): void;
  /** Selects `key` (must be visible, i.e. ancestors expanded) and scrolls to it. */
  reveal(key: string): void;
  leadKey(): string | null;
  /** Selects the next (1) / previous (-1) row, for a filter field that keeps the focus (Settings search). */
  moveSelection(dir: 1 | -1): void;
  /**
   * Next / Previous Occurrence: selects the next (1) / previous (-1) node that
   * `isOccurrence` accepts (default: leaves) after the lead, in tree order over
   * the loaded nodes, expanding its collapsed ancestors. `null` when there is none.
   * `skipSubtree`: forward, ignore the lead's descendants (after excluding a group).
   */
  selectOccurrence(dir: 1 | -1, options?: { skipSubtree?: boolean }): TreeOccurrence | null;
}

export interface TreeProps<T> {
  roots: readonly T[];
  getKey: (node: T) => string;
  getLabel: (node: T) => string;
  /** Loaded children; `undefined` for unloaded (or leaf) nodes. */
  getChildren: (node: T) => readonly T[] | undefined;
  isExpandable: (node: T) => boolean;
  /** Called when an expandable node with unloaded children is expanded. */
  loadChildren?: (node: T) => void | Promise<void>;
  /** Custom row content (after the chevron). Defaults to icon + highlighted label + `getDetail`. */
  renderNode?: (node: T, state: TreeRowState) => ReactNode;
  getIcon?: (node: T, expanded: boolean) => IconName | (string & {}) | undefined;
  /** Muted trailing text (e.g. a path next to the project root). */
  getDetail?: (node: T) => string | undefined;
  /** Label colour, e.g. VCS status. */
  getColor?: (node: T) => string | undefined;

  expanded?: ReadonlySet<string>;
  defaultExpanded?: Iterable<string>;
  onExpandedChange?: (expanded: Set<string>, node: T, isExpanded: boolean) => void;

  selected?: ReadonlySet<string>;
  defaultSelected?: Iterable<string>;
  onSelectionChange?: (selected: Set<string>, lead: T | null) => void;
  multiSelect?: boolean;

  /** Enter / double-click on a leaf (or on nodes `activateExpandable` accepts). */
  onActivate?: (node: T, e: KeyboardEvent | MouseEvent) => void;
  activateExpandable?: boolean | ((node: T) => boolean);
  /** Nodes Next / Previous Occurrence stops at (`TreeHandle.selectOccurrence`); default: leaves. */
  isOccurrence?: (node: T) => boolean;
  onContextMenu?: (node: T | null, selection: Set<string>, e: MouseEvent) => void;

  speedSearch?: boolean;
  speedSearchMode?: "highlight" | "filter";
  rowHeight?: number;
  indent?: number;
  className?: string;
  "aria-label"?: string;
  handleRef?: Ref<TreeHandle>;
  empty?: ReactNode;
}

interface Row<T> {
  node: T;
  key: string;
  depth: number;
  parent: number;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
  loading?: boolean;
}

function useControllableSet(value: ReadonlySet<string> | undefined, initial: Iterable<string> | undefined) {
  const [inner, setInner] = useState<ReadonlySet<string>>(() => new Set(initial ?? []));
  return [value ?? inner, setInner, value !== undefined] as const;
}

export function Tree<T>(props: TreeProps<T>) {
  const {
    roots,
    getKey,
    getLabel,
    getChildren,
    isExpandable,
    loadChildren,
    renderNode,
    getIcon,
    getDetail,
    getColor,
    multiSelect = true,
    onActivate,
    activateExpandable = false,
    onContextMenu,
    speedSearch = true,
    speedSearchMode = "highlight",
    rowHeight = 24,
    indent = 20,
    className,
    handleRef,
    empty,
  } = props;

  const [expanded, setExpandedInner, expandedControlled] = useControllableSet(props.expanded, props.defaultExpanded);
  const [selected, setSelectedInner, selectedControlled] = useControllableSet(props.selected, props.defaultSelected);
  const [lead, setLead] = useState<string | null>(() => [...selected][0] ?? null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const allRows = useMemo(() => {
    const rows: Row<T>[] = [];
    const walk = (nodes: readonly T[], depth: number, parent: number, parentKey: string | null) => {
      for (const node of nodes) {
        const key = getKey(node);
        const expandable = isExpandable(node);
        const isOpen = expandable && expanded.has(key);
        const index = rows.length;
        rows.push({ node, key, depth, parent, parentKey, expandable, expanded: isOpen });
        if (isOpen) {
          const children = getChildren(node);
          if (children) walk(children, depth + 1, index, key);
          else
            rows.push({
              node,
              key: `${key}\u0000loading`,
              depth: depth + 1,
              parent: index,
              parentKey: key,
              expandable: false,
              expanded: false,
              loading: true,
            });
        }
      }
    };
    walk(roots, 0, -1, null);
    return rows;
  }, [roots, expanded, getKey, isExpandable, getChildren]);

  const matchMap = useMemo(() => {
    const m = new Map<string, number[]>();
    if (!query) return m;
    for (const r of allRows) {
      if (r.loading) continue;
      const hit = fuzzyMatch(getLabel(r.node), query);
      if (hit) m.set(r.key, hit);
    }
    return m;
  }, [allRows, query, getLabel]);

  const rows = useMemo(() => {
    if (!query || speedSearchMode !== "filter") return allRows;
    const keep = new Set<number>();
    allRows.forEach((r, i) => {
      if (!matchMap.has(r.key)) return;
      for (let j = i; j >= 0 && !keep.has(j); j = allRows[j]!.parent) keep.add(j);
    });
    return allRows.filter((_, i) => keep.has(i));
  }, [allRows, matchMap, query, speedSearchMode]);

  const byKey = useMemo(() => new Map(allRows.map((r) => [r.key, r])), [allRows]);
  // aria-posinset / aria-setsize among visible siblings (rows are virtualised).
  const positions = useMemo(() => siblingPositions(rows), [rows]);
  const indexOfKey = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const leadIndex = lead != null ? (indexOfKey.get(lead) ?? -1) : -1;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (i) => rows[i]!.key,
  });

  useEffect(() => {
    if (leadIndex >= 0) virtualizer.scrollToIndex(leadIndex, { align: "auto" });
  }, [leadIndex, virtualizer]);

  // Speed search owns Escape while active.
  useEffect(() => {
    if (!query) return;
    return acquirePopup();
  }, [query]);

  const setExpanded = (row: Row<T>, open: boolean) => {
    if (!row.expandable || row.expanded === open) return;
    const next = new Set(expanded);
    if (open) next.add(row.key);
    else next.delete(row.key);
    if (!expandedControlled) setExpandedInner(next);
    props.onExpandedChange?.(next, row.node, open);
    if (open && getChildren(row.node) === undefined) void loadChildren?.(row.node);
  };

  const commitSelection = useCallback(
    (next: Set<string>, leadKey: string | null) => {
      if (!selectedControlled) setSelectedInner(next);
      setLead(leadKey);
      const leadRow = leadKey != null ? rows[indexOfKey.get(leadKey) ?? -1] : undefined;
      props.onSelectionChange?.(next, leadRow?.node ?? null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, indexOfKey, selectedControlled, props.onSelectionChange],
  );

  const selectIndex = (i: number, mode: "single" | "toggle" | "range" = "single") => {
    const row = rows[i];
    if (!row || row.loading) return;
    if (mode === "single" || !multiSelect) {
      setAnchor(row.key);
      commitSelection(new Set([row.key]), row.key);
    } else if (mode === "toggle") {
      const next = new Set(selected);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      setAnchor(row.key);
      commitSelection(next, row.key);
    } else {
      const a = anchor != null ? (indexOfKey.get(anchor) ?? i) : leadIndex >= 0 ? leadIndex : i;
      setAnchor(rows[a]!.key);
      const [s, e] = a < i ? [a, i] : [i, a];
      const next = new Set<string>();
      for (let j = s; j <= e; j++) if (!rows[j]!.loading) next.add(rows[j]!.key);
      commitSelection(next, row.key);
    }
  };

  useImperativeHandle(handleRef, () => ({
    focus: () => scrollRef.current?.focus(),
    reveal: (key: string) => {
      const i = indexOfKey.get(key);
      if (i === undefined) return;
      setAnchor(key);
      commitSelection(new Set([key]), key);
      virtualizer.scrollToIndex(i, { align: "center" });
    },
    leadKey: () => lead,
    moveSelection: (dir: 1 | -1) => {
      const key = lead != null && selected.has(lead) ? lead : ([...selected][0] ?? null);
      const from = key != null ? (indexOfKey.get(key) ?? -1) : -1;
      const i = from < 0 ? step(-1, 1) : step(from, dir);
      if (i < 0 || i === from || !rows[i]) return;
      selectIndex(i);
      virtualizer.scrollToIndex(i);
    },
    selectOccurrence: (dir: 1 | -1, options?: { skipSubtree?: boolean }) => {
      const found = findOccurrence(
        roots,
        lead,
        dir,
        { getKey, getChildren, isExpandable, isOccurrence: props.isOccurrence },
        options?.skipSubtree,
      );
      if (!found) return null;
      const missing = found.ancestors.filter((a) => !expanded.has(getKey(a)));
      if (missing.length) {
        const next = new Set(expanded);
        for (const a of missing) {
          next.add(getKey(a));
          props.onExpandedChange?.(new Set(next), a, true);
        }
        if (!expandedControlled) setExpandedInner(next);
      }
      const key = getKey(found.node);
      const sel = new Set([key]);
      setAnchor(key);
      if (!selectedControlled) setSelectedInner(sel);
      setLead(key);
      props.onSelectionChange?.(sel, found.node);
      return { key, node: found.node, index: found.index, total: found.total };
    },
  }));

  const findMatch = (from: number, dir: 1 | -1, inclusive: boolean, q = query, wrap = true): number => {
    if (!q) return -1;
    const n = rows.length;
    const test = (i: number) => {
      const r = rows[i]!;
      return !r.loading && fuzzyMatch(getLabel(r.node), q) !== null;
    };
    const start = from < 0 ? (dir === 1 ? 0 : n - 1) : from;
    for (let step = inclusive ? 0 : 1; step < n + (inclusive ? 0 : 1); step++) {
      const raw = start + dir * step;
      if (!wrap && (raw < 0 || raw >= n)) return -1;
      const i = ((raw % n) + n) % n;
      if (test(i)) return i;
    }
    return -1;
  };

  const activate = (row: Row<T>, e: KeyboardEvent | MouseEvent) => {
    if (row.loading) return;
    const activates = typeof activateExpandable === "function" ? activateExpandable(row.node) : activateExpandable;
    if (row.expandable && !activates) setExpanded(row, !row.expanded);
    else onActivate?.(row.node, e);
  };

  const step = (i: number, dir: 1 | -1) => {
    for (let j = i + dir; j >= 0 && j < rows.length; j += dir) if (!rows[j]!.loading) return j;
    return i;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const row = leadIndex >= 0 ? rows[leadIndex] : undefined;
    const pageSize = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / rowHeight) - 1);
    const typed =
      speedSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.key === " " && !query);
    if (typed) {
      const q = query + e.key;
      setQuery(q);
      const hit = findMatch(leadIndex, 1, true, q);
      if (hit >= 0) selectIndex(hit);
      e.preventDefault();
      return;
    }
    const range = e.shiftKey && multiSelect;
    // Jump to Source (F4 / ⌘↓) activates like Enter.
    if (e.key === "F4" || (e.key === "ArrowDown" && e.metaKey && !e.shiftKey && !e.altKey)) {
      if (!row) return;
      setQuery("");
      activate(row, e);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    switch (e.key) {
      case "Escape":
        if (!query) return;
        setQuery("");
        break;
      case "Backspace":
        if (!query) return;
        setQuery(query.slice(0, -1));
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (query) {
          const hit = findMatch(leadIndex, dir, false);
          if (hit >= 0) selectIndex(hit);
        } else if (leadIndex < 0) {
          selectIndex(step(-1, 1));
        } else {
          selectIndex(step(leadIndex, dir), range ? "range" : "single");
        }
        break;
      }
      case "ArrowRight":
        setQuery("");
        if (!row) return;
        if (row.expandable && !row.expanded) setExpanded(row, true);
        else if (row.expanded && rows[leadIndex + 1]?.parentKey === row.key && !rows[leadIndex + 1]!.loading)
          selectIndex(leadIndex + 1);
        break;
      case "ArrowLeft":
        setQuery("");
        if (!row) return;
        if (row.expanded) setExpanded(row, false);
        else if (row.parentKey != null) {
          const pi = indexOfKey.get(row.parentKey);
          if (pi !== undefined) selectIndex(pi);
        }
        break;
      case "Home":
      case "End": {
        const first = e.key === "Home";
        if (query) {
          const hit = findMatch(-1, first ? 1 : -1, true, query, false);
          if (hit >= 0) selectIndex(hit);
        } else selectIndex(first ? step(-1, 1) : step(rows.length, -1), range ? "range" : "single");
        break;
      }
      case "PageDown":
        setQuery("");
        selectIndex(Math.min(rows.length - 1, Math.max(0, leadIndex) + pageSize), range ? "range" : "single");
        break;
      case "PageUp":
        setQuery("");
        selectIndex(Math.max(0, leadIndex - pageSize), range ? "range" : "single");
        break;
      case "Enter":
        if (!row) return;
        setQuery("");
        activate(row, e);
        break;
      case "a":
      case "A":
        if (!(e.metaKey || e.ctrlKey) || !multiSelect) return;
        commitSelection(new Set(rows.filter((r) => !r.loading).map((r) => r.key)), lead);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onRowMouseDown = (e: MouseEvent, i: number) => {
    if (e.button === 2) {
      if (!selected.has(rows[i]!.key)) selectIndex(i);
      return;
    }
    if (e.button !== 0) return;
    setQuery("");
    if (e.shiftKey) selectIndex(i, "range");
    else if (e.metaKey || e.ctrlKey) selectIndex(i, "toggle");
    else selectIndex(i);
  };

  const leadRow = leadIndex >= 0 ? rows[leadIndex] : undefined;
  const noMatch = !!query && matchMap.size === 0;

  if (!rows.length && empty && !query)
    return <div className={clsx(styles.tree, styles.emptyWrap, className)}>{empty}</div>;

  return (
    <div className={clsx(styles.wrap, className)}>
      <div
        ref={scrollRef}
        role="tree"
        aria-label={tx(props["aria-label"])}
        aria-multiselectable={multiSelect || undefined}
        aria-activedescendant={
          leadRow && !leadRow.loading && virtualizer.getVirtualItems().some((v) => v.index === leadIndex)
            ? `${baseId}-${leadIndex}`
            : undefined
        }
        tabIndex={0}
        className={styles.tree}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setQuery("");
        }}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
                const i = rowEl ? Number(rowEl.dataset.row) : -1;
                const row = rows[i];
                const sel =
                  row && selected.has(row.key) ? new Set(selected) : row ? new Set([row.key]) : new Set<string>();
                onContextMenu(row && !row.loading ? row.node : null, sel, e);
              }
            : undefined
        }
      >
        <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            const pad = 4 + row.depth * indent;
            const style = { transform: `translateY(${v.start}px)`, height: v.size, paddingLeft: pad };
            if (row.loading) {
              return (
                <div
                  key={v.key}
                  className={clsx(styles.row, styles.loading)}
                  style={{ ...style, paddingLeft: pad + 20 }}
                  role="presentation"
                >
                  <Spinner size={12} /> <T>Loading…</T>
                </div>
              );
            }
            const isSelected = selected.has(row.key);
            const isLead = v.index === leadIndex;
            const matches = matchMap.get(row.key) ?? null;
            const state: TreeRowState = {
              depth: row.depth,
              expanded: row.expanded,
              expandable: row.expandable,
              selected: isSelected,
              lead: isLead,
              matches,
            };
            const icon = getIcon?.(row.node, row.expanded);
            const detail = getDetail?.(row.node);
            const color = getColor?.(row.node);
            return (
              <div
                key={v.key}
                id={`${baseId}-${v.index}`}
                data-row={v.index}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-posinset={positions[v.index]![0]}
                aria-setsize={positions[v.index]![1]}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-selected={isSelected}
                className={clsx(styles.row, isSelected && styles.selected, isLead && styles.lead)}
                style={style}
                onMouseDown={(e) => onRowMouseDown(e, v.index)}
                onDoubleClick={(e) => activate(row, e)}
              >
                <span
                  className={styles.chevron}
                  onMouseDown={(e) => {
                    if (!row.expandable || e.button !== 0) return;
                    e.stopPropagation();
                    setExpanded(row, !row.expanded);
                    if (!row.expanded) return;
                    if (leadRow && isDescendant(byKey, leadRow.key, row.key)) selectIndex(v.index);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {row.expandable && <Icon name={row.expanded ? "chevron-down" : "chevron-right"} size={16} />}
                </span>
                {renderNode ? (
                  renderNode(row.node, state)
                ) : (
                  <>
                    {icon && <Icon name={icon} size={16} className={styles.icon} />}
                    <HighlightedText
                      className={styles.label}
                      style={color ? { color } : undefined}
                      text={getLabel(row.node)}
                      indices={matches}
                      tone="accent"
                    />
                    {detail && <span className={styles.detail}>{detail}</span>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {query && (
        <div className={clsx(styles.speedSearch, noMatch && styles.noMatch)} role="status" aria-live="polite">
          <Icon name="search" size={12} />
          <span className={styles.speedQuery}>{query}</span>
        </div>
      )}
    </div>
  );
}

function isDescendant<T>(byKey: Map<string, Row<T>>, key: string, ancestor: string): boolean {
  for (let k = byKey.get(key)?.parentKey ?? null; k != null; k = byKey.get(k)?.parentKey ?? null)
    if (k === ancestor) return true;
  return false;
}

/** `[posInSet, setSize]` (1-based) of every row among the rows sharing its parent. */
export function siblingPositions(
  rows: ReadonlyArray<{ parentKey: string | null; loading?: boolean }>,
): Array<[number, number]> {
  const counts = new Map<string | null, number>();
  const out: Array<[number, number]> = rows.map((r) => {
    const n = (counts.get(r.parentKey) ?? 0) + 1;
    counts.set(r.parentKey, n);
    return [n, 0];
  });
  rows.forEach((r, i) => (out[i]![1] = counts.get(r.parentKey)!));
  return out;
}

/** The occurrence after (`dir` 1) / before (-1) `lead` in tree order over loaded nodes, with its ancestors. */
export function findOccurrence<T>(
  roots: readonly T[],
  lead: string | null,
  dir: 1 | -1,
  model: {
    getKey: (node: T) => string;
    getChildren: (node: T) => readonly T[] | undefined;
    isExpandable: (node: T) => boolean;
    isOccurrence?: (node: T) => boolean;
  },
  skipSubtree = false,
): { node: T; ancestors: T[]; index: number; total: number } | null {
  const occurrences: Array<{ node: T; ancestors: T[]; at: number }> = [];
  let leadAt = -1;
  let leadEnd = -1;
  let at = 0;
  const walk = (nodes: readonly T[], ancestors: T[]) => {
    for (const node of nodes) {
      const here = at++;
      const isLead = model.getKey(node) === lead;
      if (isLead) leadAt = here;
      const expandable = model.isExpandable(node);
      if (model.isOccurrence ? model.isOccurrence(node) : !expandable) occurrences.push({ node, ancestors, at: here });
      const children = expandable ? model.getChildren(node) : undefined;
      if (children?.length) walk(children, [...ancestors, node]);
      if (isLead) leadEnd = at - 1;
    }
  };
  walk(roots, []);
  const after = skipSubtree ? leadEnd : leadAt;
  let i: number;
  if (leadAt < 0) i = dir === 1 ? 0 : occurrences.length - 1;
  else if (dir === 1) i = occurrences.findIndex((o) => o.at > after);
  else i = occurrences.findLastIndex((o) => o.at < leadAt);
  const hit = occurrences[i];
  return hit ? { node: hit.node, ancestors: hit.ancestors, index: i + 1, total: occurrences.length } : null;
}
