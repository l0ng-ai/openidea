import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { HighlightedText, Icon, List, Popup, SearchField, fuzzyMatch, listNavigate, T, type PopupAnchor } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { useRunConfigTypes, runConfigTypes, type RunConfigTypeContribution } from "@/workbench/contributions";
import styles from "./Run.module.css";

export type TypeRow =
  | { kind: "group"; key: string; label: string }
  | { kind: "type"; key: string; type: RunConfigTypeContribution; indices: number[] | null; nested: boolean };

const ROW = 24;

/** "Add New Configuration" rows: types by label, grouped ones under their group; filtered by `query`. */
export function typeRows(types: readonly RunConfigTypeContribution[], query: string): TypeRow[] {
  const q = query.trim();
  const match = (t: RunConfigTypeContribution) =>
    q ? (fuzzyMatch(t.label, q) ?? (t.group && fuzzyMatch(t.group, q) ? [] : null)) : null;
  const rows: TypeRow[] = [];
  const groups = new Map<string, RunConfigTypeContribution[]>();
  const entries: Array<{ label: string; group?: string; type?: RunConfigTypeContribution }> = [];
  for (const t of types) {
    if (!t.group) {
      entries.push({ label: t.label, type: t });
      continue;
    }
    let g = groups.get(t.group);
    if (!g) {
      groups.set(t.group, (g = []));
      entries.push({ label: t.group, group: t.group });
    }
    g.push(t);
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  for (const e of entries) {
    if (e.type) {
      const indices = match(e.type);
      if (!q || indices) rows.push({ kind: "type", key: e.type.id, type: e.type, indices, nested: false });
      continue;
    }
    const members = groups
      .get(e.group!)!
      .map((t) => ({ t, indices: match(t) }))
      .filter((x) => !q || x.indices);
    if (!members.length) continue;
    rows.push({ kind: "group", key: `group:${e.group}`, label: e.group! });
    for (const { t, indices } of members) rows.push({ kind: "type", key: t.id, type: t, indices, nested: true });
  }
  return rows;
}

/** IDEA's "Add New Configuration" popup: a searchable list of configuration types. */
export function AddConfigPopup({
  anchor,
  onPick,
  onClose,
}: {
  anchor: PopupAnchor;
  onPick: (type: RunConfigTypeContribution) => void;
  onClose: () => void;
}) {
  const types = useRunConfigTypes((s) => s.types);
  const rowHeight = useRowHeight(ROW);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => typeRows(runConfigTypes(types), query), [types, query]);
  const isSection = (r: TypeRow) => r.kind === "group";
  const first = Math.max(
    0,
    rows.findIndex((r) => r.kind === "type"),
  );
  const [active, setActive] = useState(first);
  const clamped = Math.min(active, rows.length - 1);

  const pick = (row: TypeRow | undefined) => {
    if (row?.kind !== "type") return;
    onClose();
    onPick(row.type);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[clamped]);
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: clamped, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  return (
    <Popup
      open
      anchor={anchor}
      onClose={onClose}
      placement="bottom-start"
      aria-label="Add New Configuration"
      className={styles.chooser}
      trapFocus
    >
      <div className={styles.chooserCaption}>
        <T>Add New Configuration</T>
      </div>
      <div className={styles.chooserSearch}>
        <SearchField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          placeholder="Search types"
          aria-label="Search configuration types"
          data-autofocus=""
          onKeyDown={onKeyDown}
          variant="bare"
        />
      </div>
      <div style={{ height: Math.max(rowHeight, Math.min(rows.length * rowHeight, 14 * rowHeight)) }}>
        <List<TypeRow>
          aria-label="Configuration types"
          className={styles.chooserList}
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => (r.kind === "group" ? r.label : null)}
          activeIndex={rows[clamped]?.kind === "type" ? clamped : first}
          onActiveChange={setActive}
          focusable={false}
          hoverSelects
          rowHeight={rowHeight}
          onActivate={(r) => pick(r)}
          empty={
            <span className={styles.chooserMuted}>
              <T>Nothing found</T>
            </span>
          }
          renderItem={(r) =>
            r.kind === "type" ? (
              <span className={clsx(styles.chooserRow, r.nested && styles.typeNested)} title={r.type.description}>
                <Icon name={r.type.icon} size={13} className={styles.chooserIcon} />
                <span className={styles.chooserName}>
                  {r.indices?.length ? <HighlightedText text={r.type.label} indices={r.indices} /> : r.type.label}
                </span>
              </span>
            ) : null
          }
        />
      </div>
    </Popup>
  );
}
