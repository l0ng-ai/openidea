import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Branch } from "@/bindings";
import { HighlightedText, Icon, List, Popup, SearchField, T, firstSelectable, fuzzyMatch, listNavigate } from "@/ui";
import { tx } from "@/platform/i18n";
import { isFavoriteBranch, sortLocal, sortRemote } from "./branches";
import { loadFavoriteBranches, useFavoriteBranches } from "./branchOps";
import styles from "./GitLog.module.css";

type Group = "local" | "remote";

type Row =
  | { type: "section"; key: string; label: string }
  | { type: "group"; key: string; group: Group; label: string; expanded: boolean }
  | {
      type: "ref";
      key: string;
      value: string;
      label: string;
      current: boolean;
      favorite: boolean;
      nested: boolean;
      matches: number[] | null;
    };

const ROW_HEIGHT = 24;
const MAX_LIST_HEIGHT = 320;
const INDENT = 16;

/**
 * IDEA's branch filter: HEAD, the favorite branches (★), then Local and Remote collapsed like its
 * submenus. A query lists every match under Local and Remote instead.
 */
function buildRows(
  branches: readonly Branch[],
  favorites: readonly string[] | null,
  query: string,
  expanded: ReadonlySet<Group>,
): Row[] {
  const q = query.trim();
  const rows: Row[] = [];
  const ref = (value: string, label: string, b: Branch | null, key: string, nested: boolean): Row[] => {
    const matches = q ? fuzzyMatch(label, q) : null;
    if (q && !matches) return [];
    const favorite = !!b && isFavoriteBranch(b, favorites);
    return [{ type: "ref", key, value, label, current: !!b?.current, favorite, nested, matches }];
  };
  rows.push(...ref("HEAD", tx("HEAD (Current Branch)"), null, "ref:HEAD", false));
  const lists: Array<[Group, string, Branch[]]> = [
    ["local", tx("Local"), sortLocal(branches, favorites)],
    ["remote", tx("Remote"), sortRemote(branches, favorites)],
  ];
  if (q) {
    for (const [group, label, list] of lists) {
      const items = list.flatMap((b) => ref(b.name, b.name, b, `ref:${b.name}`, false));
      if (items.length) rows.push({ type: "section", key: `section:${group}`, label }, ...items);
    }
    return rows;
  }
  const favorite = lists
    .flatMap(([, , list]) => list)
    .filter((b) => isFavoriteBranch(b, favorites))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (favorite.length)
    rows.push(
      { type: "section", key: "section:favorites", label: tx("Favorites") },
      ...favorite.flatMap((b) => ref(b.name, b.name, b, `favorite:${b.name}`, false)),
    );
  for (const [group, label, list] of lists) {
    if (!list.length) continue;
    const open = expanded.has(group);
    rows.push({ type: "group", key: `group:${group}`, group, label, expanded: open });
    if (open) rows.push(...list.flatMap((b) => ref(b.name, b.name, b, `ref:${b.name}`, true)));
  }
  return rows;
}

const isSection = (r: Row) => r.type === "section";

export function BranchFilterPopup({
  anchor,
  branches,
  selected,
  onSelect,
  onSelectMany,
  onClose,
}: {
  anchor: HTMLElement;
  branches: readonly Branch[];
  selected: readonly string[];
  onSelect: (branch: string) => void;
  onSelectMany: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<Group>>(new Set());
  const favorites = useFavoriteBranches((s) => s.names);
  useEffect(() => loadFavoriteBranches(), []);
  const rows = useMemo(() => buildRows(branches, favorites, query, expanded), [branches, favorites, query, expanded]);
  const activeIndex = rows[active] && !isSection(rows[active]!) ? active : firstSelectable(rows, isSection);
  const toggle = (group: Group, open: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(group);
      else next.delete(group);
      return next;
    });
  const activate = (row: Row | undefined) => {
    if (row?.type === "ref") onSelect(row.value);
    else if (row?.type === "group") toggle(row.group, !row.expanded);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const row = rows[activeIndex];
    if (e.key === "Enter") {
      e.preventDefault();
      activate(row);
      return;
    }
    if (row?.type === "group" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      toggle(row.group, e.key === "ArrowRight");
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: activeIndex, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };
  const height = Math.min(MAX_LIST_HEIGHT, Math.max(ROW_HEIGHT * 3, rows.length * ROW_HEIGHT));
  return (
    <Popup
      open
      anchor={anchor}
      onClose={onClose}
      className={styles.branchFilterPopup}
      aria-label={tx("Filter by Branch")}
    >
      <div className={styles.branchFilterSearch}>
        <SearchField
          data-autofocus
          variant="bare"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search branches"
          aria-label="Search branches"
        />
      </div>
      <div className={styles.branchFilterList} style={{ height }}>
        <List
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => (
            <span className={styles.branchFilterSection}>{r.type === "section" ? r.label : ""}</span>
          )}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onActivate={activate}
          focusable={false}
          hoverSelects
          rowHeight={ROW_HEIGHT}
          aria-label="Branches"
          className={styles.branchFilterListBody}
          empty={
            <span className={styles.branchFilterEmpty}>
              <T>No matching branches</T>
            </span>
          }
          renderItem={(r) =>
            r.type === "group" ? (
              <span className={styles.branchFilterRow} aria-expanded={r.expanded}>
                <Icon
                  name={r.expanded ? "chevron-down" : "chevron-right"}
                  size={12}
                  className={styles.branchFilterIcon}
                />
                <span className={styles.branchFilterLabel}>{r.label}</span>
              </span>
            ) : r.type === "ref" ? (
              <span className={styles.branchFilterRow} style={r.nested ? { paddingLeft: INDENT } : undefined}>
                <Icon
                  name={r.current ? "current-branch" : r.favorite ? "star" : "branch"}
                  size={14}
                  className={r.current ? styles.branchFilterCurrent : styles.branchFilterIcon}
                />
                <HighlightedText
                  className={styles.branchFilterLabel}
                  text={r.label}
                  indices={r.matches}
                  tone="accent"
                />
                {selected.includes(r.value) && <Icon name="check" size={14} className={styles.branchFilterCheck} />}
              </span>
            ) : null
          }
        />
      </div>
      <button type="button" className={styles.branchFilterMore} onClick={onSelectMany}>
        <T>Select…</T>
      </button>
    </Popup>
  );
}
