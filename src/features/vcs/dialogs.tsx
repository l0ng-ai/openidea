/** Imperative dialogs for VCS actions, rendered by one overlay contribution. */
import { Fragment, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Checkbox, Dialog, Input, T } from "@/ui";
import { confirm } from "@/workbench/messages";
import styles from "./common.module.css";

interface DialogEntry {
  id: number;
  render: (close: () => void) => ReactNode;
}

const useVcsDialogs = create<{ stack: DialogEntry[] }>(() => ({ stack: [] }));
let seq = 0;

/** Shows `render(close)` above the workbench; returns `close`. */
export function openDialog(render: (close: () => void) => ReactNode): () => void {
  const id = ++seq;
  const close = () => useVcsDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  useVcsDialogs.setState((s) => ({ stack: [...s.stack, { id, render }] }));
  return close;
}

export function VcsDialogHost() {
  const stack = useVcsDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>
          {e.render(() => useVcsDialogs.setState((s) => ({ stack: s.stack.filter((x) => x.id !== e.id) })))}
        </Fragment>
      ))}
    </>
  );
}

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  mono?: boolean;
  /** Returns an error message, or null when valid. */
  validate?: (value: string) => string | null;
  /** Optional checkbox below the field. */
  checkbox?: { label: string; initial: boolean };
}

export interface PromptResult {
  value: string;
  checked: boolean;
}

export function promptText(opts: PromptOptions): Promise<PromptResult | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <PromptDialog
        {...opts}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function PromptDialog(props: PromptOptions & { onDone: (r: PromptResult | null) => void }) {
  const { title, label, initial = "", placeholder, okLabel = "OK", mono, validate, checkbox, onDone } = props;
  const [value, setValue] = useState(initial);
  const [checked, setChecked] = useState(checkbox?.initial ?? false);
  const [touched, setTouched] = useState(false);
  const error = validate ? validate(value) : value.trim() ? null : "Value must not be empty";
  const submit = () => {
    setTouched(true);
    if (!error) onDone({ value: value.trim(), checked });
  };
  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={420}
      buttons={[
        { label: okLabel, role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {label && (
          <label className={styles.fieldLabel}>
            <T>{label}</T>
          </label>
        )}
        <Input
          data-autofocus
          aria-label={label ?? title}
          value={value}
          mono={mono}
          placeholder={placeholder}
          invalid={touched && !!error}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
          }}
        />
        {touched && error && value && <div className={styles.error}>{error}</div>}
        {checkbox && <Checkbox checked={checked} onChange={setChecked} label={checkbox.label} />}
      </form>
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  okLabel?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return confirm({
    title: opts.title,
    message: opts.message,
    ok: opts.okLabel ?? "OK",
    icon: opts.danger ? "warning" : "question",
  });
}

export interface ChooseManyOptions {
  title: string;
  /** Values offered as checkboxes. */
  options: readonly string[];
  initial: readonly string[];
  /** Label of a free-text field for values not in `options` (comma-separated). */
  customLabel?: string;
  okLabel?: string;
}

/** Splits a comma-separated list, trimming blanks. */
export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Multi-select chooser (Log Branch / User filters › Select…); null when cancelled. */
export function chooseMany(opts: ChooseManyOptions): Promise<string[] | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <ChooseManyDialog
        {...opts}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function ChooseManyDialog(props: ChooseManyOptions & { onDone: (r: string[] | null) => void }) {
  const { title, options, initial, customLabel, okLabel = "OK", onDone } = props;
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(() => new Set(initial.filter((v) => options.includes(v))));
  const [custom, setCustom] = useState(() => initial.filter((v) => !options.includes(v)).join(", "));
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  const submit = () => onDone([...options.filter((o) => checked.has(o)), ...(customLabel ? splitList(custom) : [])]);
  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={420}
      buttons={[
        { label: okLabel, role: "default", onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          data-autofocus
          aria-label="Filter"
          placeholder="Filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={styles.choiceList} role="group" aria-label={title}>
          {shown.map((o) => (
            <div key={o} className={styles.fileRow}>
              <Checkbox
                checked={checked.has(o)}
                label={o}
                onChange={(v) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    if (v) n.add(o);
                    else n.delete(o);
                    return n;
                  })
                }
              />
            </div>
          ))}
        </div>
        {customLabel && (
          <>
            <label className={styles.fieldLabel}>
              <T>{customLabel}</T>
            </label>
            <Input aria-label={customLabel} value={custom} onChange={(e) => setCustom(e.target.value)} />
          </>
        )}
      </form>
    </Dialog>
  );
}

/** Local date of an `<input type="date">` value (`2024-05-01`) as epoch ms at local midnight. */
export function parseDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Date filter › Select…: `after` inclusive, `before` the day after the chosen "To" date. */
export function chooseDateRange(): Promise<{ after: number | null; before: number | null } | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <DateRangeDialog
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function DateRangeDialog({ onDone }: { onDone: (r: { after: number | null; before: number | null } | null) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const after = parseDay(from);
  const toDay = parseDay(to);
  const before = toDay == null ? null : new Date(toDay).setDate(new Date(toDay).getDate() + 1);
  const error =
    after == null && before == null
      ? "Choose a start or end date"
      : after != null && before != null && after >= before
        ? "The start date is after the end date"
        : null;
  const submit = () => {
    if (!error) onDone({ after, before });
  };
  return (
    <Dialog
      open
      title="Filter by Date"
      onClose={() => onDone(null)}
      width={360}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.fieldLabel}>
          <T>From:</T>
        </label>
        <Input data-autofocus type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label className={styles.fieldLabel}>
          <T>To:</T>
        </label>
        <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        {(from || to) && error && <div className={styles.error}>{error}</div>}
      </form>
    </Dialog>
  );
}
