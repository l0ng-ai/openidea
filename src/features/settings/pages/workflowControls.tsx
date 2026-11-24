/**
 * Form pieces of the Version Control / Build, Execution, Deployment / Tools
 * pages: bound checkboxes, "[x] Limit … to: [N] unit" rows,
 * two-column grids, string lists and editable two-column tables.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Checkbox, IconButton, Input } from "@/ui";
import { NumberInput, Row, SearchLabel, Toggle } from "../components/Form";
import { useLabelMatch, useSetting } from "../components/context";
import { selectPage, type Scope } from "../model/staging";
import styles from "./Workflow.module.css";

export function BoundToggle({
  k,
  label,
  hint,
  disabled,
  scope,
}: {
  k: string;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  scope?: Scope;
}) {
  const [value, set] = useSetting<boolean>(k, scope);
  return <Toggle label={label} checked={!!value} onChange={set} hint={hint} disabled={disabled} />;
}

export function Indented({ children }: { children: ReactNode }) {
  return <div className={styles.indented}>{children}</div>;
}

/** IDEA's two-column checkbox grid. */
export function Grid({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className={styles.grid}>
      <div className={styles.column}>{left}</div>
      <div className={styles.column}>{right}</div>
    </div>
  );
}

/** `[x] Limit history to: [1000] rows` — a checkbox enabling a number. */
export function ToggleNumber({
  toggleKey,
  numberKey,
  label,
  unit,
  min,
  max,
  hint,
  disableWhenOff,
}: {
  toggleKey: string;
  numberKey: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  hint?: ReactNode;
  disableWhenOff?: boolean;
}) {
  const [on, setOn] = useSetting<boolean>(toggleKey);
  const [n, setN] = useSetting<number>(numberKey);
  const matched = useLabelMatch(label);
  return (
    <div className={clsx(styles.inlineRow, matched && styles.matched)} data-search-match={matched || undefined}>
      <Checkbox
        checked={!!on}
        onChange={setOn}
        label={
          <>
            <SearchLabel text={label} />:
          </>
        }
      />
      <NumberInput
        value={n}
        onChange={setN}
        min={min}
        max={max}
        integer
        disabled={disableWhenOff && !on}
        aria-label={label}
      />
      {unit && <span className={clsx(styles.unit, !on && styles.disabled)}>{unit}</span>}
      {hint && <span className={styles.inlineHint}>{hint}</span>}
    </div>
  );
}

export interface RadioChoice<V extends string> {
  value: V;
  label: string;
}

/** `Label:  (•) A  ( ) B  ( ) C` bound to a key. */
export function RadioRow<V extends string>({
  k,
  label,
  choices,
  hint,
  scope,
}: {
  k: string;
  label: string;
  choices: readonly RadioChoice<V>[];
  hint?: ReactNode;
  scope?: Scope;
}) {
  const [value, set] = useSetting<V>(k, scope);
  const name = useId();
  return (
    <Row label={label} hint={hint}>
      <div className={styles.radios} role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <label key={c.value} className={styles.radio}>
            <input type="radio" name={name} checked={value === c.value} onChange={() => set(c.value)} />
            <SearchLabel text={c.label} />
          </label>
        ))}
      </div>
    </Row>
  );
}

/** Link-style button that jumps to another settings page. */
export function PageLink({ page, children }: { page: string; children: ReactNode }) {
  return (
    <button type="button" className={styles.link} onClick={() => selectPage(page)}>
      {children}
    </button>
  );
}

export interface TableColumn {
  key: string;
  title: string;
  placeholder?: string;
  mono?: boolean;
}

/**
 * Editable table with a +/−/edit toolbar (IDEA's Issue Navigation /
 * environment variables tables). Rows are plain records of strings; a row
 * whose first column is empty is dropped on commit.
 */
export function TableEditor({
  rows,
  columns,
  onChange,
  empty,
  "aria-label": ariaLabel,
}: {
  rows: readonly Record<string, string>[];
  columns: readonly TableColumn[];
  onChange: (rows: Record<string, string>[]) => void;
  empty: string;
  "aria-label": string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ index: number; row: Record<string, string> } | null>(null);
  const first = columns[0]!.key;

  const commit = () => {
    if (!editing) return;
    const next = [...rows];
    const row = Object.fromEntries(columns.map((c) => [c.key, (editing.row[c.key] ?? "").trim()]));
    if (!row[first]) {
      if (editing.index < rows.length) next.splice(editing.index, 1);
    } else if (editing.index >= rows.length) next.push(row);
    else next[editing.index] = row;
    onChange(next);
    setEditing(null);
    setSelected(row[first] ? Math.min(editing.index, next.length - 1) : null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setEditing(null);
    }
  };

  const remove = () => {
    if (selected === null) return;
    onChange(rows.filter((_, i) => i !== selected));
    setSelected(null);
  };

  const shown = editing && editing.index >= rows.length ? [...rows, editing.row] : rows;
  return (
    <div className={styles.tableBox}>
      <div className={styles.toolbar} role="toolbar" aria-label={`${ariaLabel} actions`}>
        <IconButton
          icon="plus"
          title="Add"
          size="small"
          onClick={() => setEditing({ index: rows.length, row: Object.fromEntries(columns.map((c) => [c.key, ""])) })}
        />
        <IconButton icon="minus" title="Remove" size="small" disabled={selected === null} onClick={remove} />
        <IconButton
          icon="edit"
          title="Edit"
          size="small"
          disabled={selected === null}
          onClick={() => selected !== null && setEditing({ index: selected, row: { ...rows[selected]! } })}
        />
      </div>
      <table className={styles.table} aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {empty}
              </td>
            </tr>
          )}
          {shown.map((row, i) => (
            <tr
              key={i}
              aria-selected={selected === i}
              className={clsx(selected === i && styles.selectedRow)}
              onMouseDown={() => setSelected(i)}
              onDoubleClick={() => setEditing({ index: i, row: { ...row } })}
            >
              {columns.map((c, ci) => (
                <td key={c.key} className={clsx(c.mono && styles.mono)}>
                  {editing?.index === i ? (
                    <Input
                      autoFocus={ci === 0}
                      mono={c.mono}
                      variant="bare"
                      className={styles.cellInput}
                      value={editing.row[c.key] ?? ""}
                      placeholder={c.placeholder}
                      aria-label={c.title}
                      onChange={(e) => setEditing({ index: i, row: { ...editing.row, [c.key]: e.target.value } })}
                      onKeyDown={onKey}
                      onBlur={(e) => {
                        // Moving between the cells of the edited row keeps editing.
                        if (!e.currentTarget.closest("tr")?.contains(e.relatedTarget as Node | null)) commit();
                      }}
                    />
                  ) : (
                    row[c.key]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
