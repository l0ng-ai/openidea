/**
 * Go to Column in a table editor (⌘F12 / Ctrl+F12): the grid's columns, filtered as you type;
 * Enter selects that column's cell in the current row.
 */
import { useState } from "react";
import { Icon, Input, List, Popup, listNavigate } from "@/ui";
import { tx } from "@/platform/i18n";
import type { GridColumn } from "./Grid";
import styles from "./Database.module.css";

export function filterColumns(columns: readonly GridColumn[], query: string): number[] {
  const q = query.trim().toLowerCase();
  const all = columns.map((_, i) => i);
  if (!q) return all;
  const starts = all.filter((i) => columns[i]!.name.toLowerCase().startsWith(q));
  const contains = all.filter((i) => !starts.includes(i) && columns[i]!.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

export function ColumnsPopup(props: {
  anchor: { x: number; y: number };
  table: string;
  columns: readonly GridColumn[];
  onPick: (col: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const shown = filterColumns(props.columns, query);
  const current = Math.min(active, shown.length - 1);
  const pick = (i: number) => {
    const col = shown[i];
    if (col !== undefined) props.onPick(col);
  };
  return (
    <Popup
      open
      anchor={props.anchor}
      placement="bottom"
      onClose={props.onClose}
      aria-label={tx`Columns of ${props.table}`}
      className={styles.columnsPopup}
      trapFocus
    >
      <Input
        autoFocus
        aria-label={tx("Search columns")}
        placeholder={tx`Columns of ${props.table}`}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            pick(current);
            return;
          }
          const next = listNavigate(e.key, { items: shown, active: current });
          if (next !== null) {
            e.preventDefault();
            setActive(next);
          }
        }}
      />
      <List
        items={shown}
        getKey={(col) => String(col)}
        activeIndex={current}
        onActiveChange={setActive}
        onActivate={(_, i) => pick(i)}
        focusable={false}
        hoverSelects
        rowHeight={22}
        aria-label={tx("Columns")}
        className={styles.columnsList}
        empty={<span>{tx("No matching columns")}</span>}
        renderItem={(col) => {
          const c = props.columns[col]!;
          return (
            <span className={styles.columnsRow}>
              <Icon name={c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column"} size={16} />
              {c.name}
              {c.type && c.type !== "NULL" && <span className={styles.treeType}>{c.type}</span>}
            </span>
          );
        }}
      />
    </Popup>
  );
}
