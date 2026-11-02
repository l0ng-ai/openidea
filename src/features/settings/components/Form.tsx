/**
 * Settings form components with IDEA metrics (24px controls, 28px rows,
 * titled separators). Labels highlight the dialog's search matches.
 * `Setting*` variants bind straight to a staged settings key.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Checkbox, IconButton, Input, Select as UiSelect, type SelectOption, T } from "@/ui";
import { tx, useTx } from "@/platform/i18n";
import { highlightIndices } from "../model/pages";
import { HEX_COLOR } from "../model/schema";
import { useLabelMatch, useSearchQuery, useSetting } from "./context";
import styles from "./Form.module.css";

/** Text with search matches marked. */
export function SearchLabel({ text: source, className }: { text: string; className?: string }) {
  const q = useSearchQuery();
  const text = useTx()(source);
  const hits = highlightIndices(text, q);
  if (!hits) return <span className={className}>{text}</span>;
  const parts: ReactNode[] = [];
  let pos = 0;
  let i = 0;
  while (i < hits.length) {
    const start = hits[i]!;
    let end = start + 1;
    while (hits[i + 1] === end) {
      i++;
      end++;
    }
    i++;
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark key={start} className={styles.mark}>
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <span className={className}>{parts}</span>;
}

export function Section({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={clsx(styles.section, className)} aria-label={tx(title)}>
      {title && (
        <div className={styles.sectionTitle}>
          <SearchLabel text={title} />
          <span className={styles.sectionRule} aria-hidden />
        </div>
      )}
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

export interface RowProps {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  /** Id of the control the label describes. */
  htmlFor?: string;
  /** Control under the label (lists, previews) instead of beside it. */
  stacked?: boolean;
  className?: string;
}

export function Row({ label, hint, children, htmlFor, stacked, className }: RowProps) {
  const matched = useLabelMatch(label);
  return (
    <div
      className={clsx(styles.row, stacked && styles.stacked, matched && styles.matched, className)}
      data-search-match={matched || undefined}
    >
      <label className={styles.label} htmlFor={htmlFor}>
        <SearchLabel text={label} />
      </label>
      <div className={styles.control}>{children}</div>
      {hint && <div className={styles.hint}>{typeof hint === "string" ? <T>{hint}</T> : hint}</div>}
    </div>
  );
}

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}

/** IDEA-style checkbox option. */
export function Toggle({ label, checked, onChange, hint, disabled }: ToggleProps) {
  const matched = useLabelMatch(label);
  return (
    <div
      className={clsx(styles.row, styles.toggleRow, matched && styles.matched)}
      data-search-match={matched || undefined}
    >
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={<SearchLabel text={label} />} />
      {hint && (
        <div className={clsx(styles.hint, styles.toggleHint)}>{typeof hint === "string" ? <T>{hint}</T> : hint}</div>
      )}
    </div>
  );
}

export interface NumberInputProps {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Integer-only input. */
  integer?: boolean;
  unit?: string;
  "aria-label"?: string;
}

export function parseNumberInput(
  text: string,
  { min, max, integer }: { min: number; max: number; integer?: boolean },
): number | null {
  if (!/^\s*-?\d+(?:\.\d+)?\s*$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (integer && !Number.isInteger(n)) return null;
  return n;
}

/** Number field: edits commit while valid; invalid text is flagged and reverted on blur. */
export function NumberInput({ id, value, onChange, min, max, step = 1, integer, unit, ...aria }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const invalid = draft !== null && parseNumberInput(draft, { min, max, integer }) === null;
  return (
    <span className={styles.number}>
      <Input
        id={id}
        className={styles.numberInput}
        inputMode={integer ? "numeric" : "decimal"}
        value={text}
        invalid={invalid}
        aria-label={aria["aria-label"]}
        aria-valuemin={min}
        aria-valuemax={max}
        title={invalid ? tx`Enter a value between ${min} and ${max}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseNumberInput(e.target.value, { min, max, integer });
          if (n !== null) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const n = Math.min(max, Math.max(min, +(value + (e.key === "ArrowUp" ? step : -step)).toFixed(4)));
          setDraft(null);
          onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
      {unit && <span className={styles.unit}>{unit}</span>}
    </span>
  );
}

export interface SelectProps<V extends string> {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Select<V extends string>({ value, options, onChange, disabled, ...aria }: SelectProps<V>) {
  return (
    <UiSelect<V>
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      className={styles.select}
      aria-label={aria["aria-label"]}
    />
  );
}

export interface ColorSwatchesProps {
  value: string;
  presets: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  /** Offer a custom colour picker + hex field. */
  allowCustom?: boolean;
  "aria-label"?: string;
}

export function ColorSwatches({ value, presets, onChange, allowCustom = true, ...aria }: ColorSwatchesProps) {
  const current = value.toLowerCase();
  const isPreset = presets.some((p) => p.value.toLowerCase() === current);
  const [hex, setHex] = useState<string | null>(null);
  const hexText = hex ?? (isPreset ? "" : value);
  const hexInvalid = hex !== null && hex !== "" && !HEX_COLOR.test(hex);
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={aria["aria-label"]}>
      {presets.map((p) => {
        const on = p.value.toLowerCase() === current;
        return (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={p.label}
            title={`${p.label} (${p.value})`}
            className={clsx(styles.swatch, on && styles.swatchOn)}
            onClick={() => onChange(p.value)}
          >
            <span className={styles.swatchColor} style={{ background: p.value }} />
          </button>
        );
      })}
      {allowCustom && (
        <>
          <label
            className={clsx(styles.swatch, styles.custom, !isPreset && styles.swatchOn)}
            title={tx("Custom colour")}
            aria-checked={!isPreset}
            role="radio"
          >
            <span className={styles.swatchColor} style={!isPreset ? { background: value } : undefined} />
            <input
              type="color"
              className={styles.colorNative}
              aria-label={tx("Custom colour")}
              value={HEX_COLOR.test(value) && value.length === 7 ? value : "#808080"}
              onChange={(e) => onChange(e.target.value)}
            />
          </label>
          <Input
            className={styles.hexInput}
            mono
            placeholder="#rrggbb"
            aria-label="Custom colour hex"
            value={hexText}
            invalid={hexInvalid}
            onChange={(e) => {
              setHex(e.target.value);
              if (HEX_COLOR.test(e.target.value)) onChange(e.target.value.toLowerCase());
            }}
            onBlur={() => setHex(null)}
          />
        </>
      )}
    </div>
  );
}

export interface GlobListEditorProps {
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  "aria-label"?: string;
  /** Shown for an empty list. */
  emptyText?: string;
  /** Accessible name of the inline editor. */
  itemLabel?: string;
}

/** Editable list of glob patterns (+ / − / edit toolbar, inline editing); also plain string lists. */
export function GlobListEditor({
  value,
  onChange,
  placeholder = "**/pattern",
  emptyText = "No patterns",
  itemLabel = "Pattern",
  ...aria
}: GlobListEditorProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const commit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    const next = [...value];
    if (!text) {
      if (editing.index >= value.length) setEditing(null);
      else {
        next.splice(editing.index, 1);
        onChange(next);
        setEditing(null);
        setSelected(null);
      }
      return;
    }
    if (editing.index >= value.length) next.push(text);
    else next[editing.index] = text;
    onChange([...new Set(next)]);
    setSelected(Math.min(editing.index, next.length - 1));
    setEditing(null);
  };

  const remove = () => {
    if (selected === null) return;
    const next = value.filter((_, i) => i !== selected);
    onChange(next);
    setSelected(next.length ? Math.min(selected, next.length - 1) : null);
  };

  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setEditing(null);
      listRef.current?.focus();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (editing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!value.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSelected((s) => (s === null ? 0 : Math.max(0, Math.min(value.length - 1, s + d))));
    } else if ((e.key === "Enter" || e.key === "F2") && selected !== null) {
      e.preventDefault();
      setEditing({ index: selected, text: value[selected] ?? "" });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove();
    }
  };

  const rows = editing && editing.index >= value.length ? [...value, ""] : value;
  return (
    <div className={styles.globEditor}>
      <div className={styles.listToolbar} role="toolbar" aria-controls={listId}>
        <IconButton
          icon="plus"
          title="Add"
          size="small"
          onClick={() => setEditing({ index: value.length, text: "" })}
        />
        <IconButton icon="minus" title="Remove" size="small" disabled={selected === null} onClick={remove} />
        <IconButton
          icon="edit"
          title="Edit"
          size="small"
          disabled={selected === null}
          onClick={() => selected !== null && setEditing({ index: selected, text: value[selected] ?? "" })}
        />
      </div>
      <ul
        id={listId}
        ref={listRef}
        className={styles.globList}
        role="listbox"
        aria-label={aria["aria-label"]}
        tabIndex={0}
        aria-activedescendant={selected !== null ? `${listId}-${selected}` : undefined}
        onKeyDown={onListKey}
      >
        {rows.length === 0 && (
          <li className={styles.globEmpty}>
            <T>{emptyText}</T>
          </li>
        )}
        {rows.map((glob, i) => (
          <li
            key={i}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={selected === i}
            className={clsx(styles.globRow, selected === i && styles.globSelected)}
            onMouseDown={() => setSelected(i)}
            onDoubleClick={() => setEditing({ index: i, text: glob })}
          >
            {editing?.index === i ? (
              <Input
                autoFocus
                mono
                variant="bare"
                className={styles.globInput}
                value={editing.text}
                placeholder={placeholder}
                aria-label={itemLabel}
                onChange={(e) => setEditing({ index: i, text: e.target.value })}
                onKeyDown={onEditKey}
                onBlur={commit}
              />
            ) : (
              <span className={styles.globText}>{glob}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bound to settings keys

export function SettingToggle({ k, label, hint }: { k: string; label: string; hint?: ReactNode }) {
  const [value, set] = useSetting<boolean>(k);
  return <Toggle label={label} checked={!!value} onChange={set} hint={hint} />;
}

export function SettingNumber({
  k,
  label,
  hint,
  ...limits
}: {
  k: string;
  label: string;
  hint?: ReactNode;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  unit?: string;
}) {
  const [value, set] = useSetting<number>(k);
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <NumberInput id={id} value={value} onChange={set} aria-label={label} {...limits} />
    </Row>
  );
}

export function SettingSelect<V extends string>({
  k,
  label,
  hint,
  options,
}: {
  k: string;
  label: string;
  hint?: ReactNode;
  options: readonly SelectOption<V>[];
}) {
  const [value, set] = useSetting<V>(k);
  return (
    <Row label={label} hint={hint}>
      <Select<V> value={value} options={options} onChange={set} aria-label={label} />
    </Row>
  );
}

export function SettingText({
  k,
  label,
  hint,
  placeholder,
}: {
  k: string;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const [value, set] = useSetting<string>(k);
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        className={styles.text}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </Row>
  );
}
