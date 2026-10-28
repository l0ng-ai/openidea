import { useMemo, useState, type KeyboardEvent } from "react";
import type { Branch } from "@/bindings";
import { HighlightedText, Icon, List, Popup, SearchField, T, firstSelectable, fuzzyMatch, listNavigate } from "@/ui";
import { tx } from "@/platform/i18n";
import { sortLocal, sortRemote } from "./branches";
import styles from "./GitLog.module.css";

type Row =
  | { type: "section"; key: string; label: string }
  | { type: "ref"; key: string; value: string; label: string; current: boolean; matches: number[] | null };

const ROW_HEIGHT = 24;
const MAX_LIST_HEIGHT = 320;

/** HEAD, then Local and Remote groups; groups without a match are left out. */
function buildRows(branches: readonly Branch[], query: string): Row[] {
  const q = query.trim();
  const rows: Row[] = [];
  const push = (value: string, label: string, current: boolean, out: Row[]) => {
    const matches = q ? fuzzyMatch(label, q) : null;
    if (q && !matches) return;
    out.push({ type: "ref", key: `ref:${value}`, value, label, current, matches });
  };
  push("HEAD", tx("HEAD (Current Branch)"), false, rows);
  const group = (key: string, label: string, list: readonly Branch[]) => {
    const items: Row[] = [];
    for (const b of list) push(b.name, b.name, b.current, items);
    if (items.length) rows.push({ type: "section", key: `section:${key}`, label }, ...items);
  };
  group("local", tx("Local"), sortLocal(branches));
  group("remote", tx("Remote"), sortRemote(branches));
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
  const rows = useMemo(() => buildRows(branches, query), [branches, query]);
  const activeIndex = rows[active] && !isSection(rows[active]!) ? active : firstSelectable(rows, isSection);
  const activate = (row: Row | undefined) => {
    if (row?.type === "ref") onSelect(row.value);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[activeIndex]);
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
            r.type === "ref" ? (
              <span className={styles.branchFilterRow}>
                <Icon
                  name={r.current ? "current-branch" : "branch"}
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
