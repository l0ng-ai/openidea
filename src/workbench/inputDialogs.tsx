/**
 * Promise-based input dialogs for shell and feature actions (IDEA's
 * `Messages.showInputDialog` and a simple chooser):
 *
 *   const name = await promptInput({ title: "Save Layout", label: "Name:" });
 *   const picked = await chooseItem({ title: "Delete Layout", items: names });
 *
 * Rendered by `InputDialogsHost` (in `OverlayHost`).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { t } from "@/platform/i18n";
import { Dialog, Input, List, T } from "@/ui";
import styles from "./inputDialogs.module.css";

export interface PromptInputOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  /** An error message for `value`, or null when valid (default: must not be blank). */
  validate?: (value: string) => string | null;
  /** Validate on submission without closing the dialog; cancelling aborts pending validation. */
  submit?: (value: string, signal: AbortSignal) => Promise<string | null>;
  /** Initial server validation error. */
  error?: string;
  /** Extra content under the field (hints). */
  hint?: ReactNode;
}

export interface ChooseItemOptions {
  title: string;
  items: readonly string[];
  /** Shown when `items` is empty. */
  empty?: string;
}

type Request =
  | { kind: "prompt"; id: number; options: PromptInputOptions; resolve: (v: string | null) => void }
  | { kind: "choose"; id: number; options: ChooseItemOptions; resolve: (v: string | null) => void };

const useInputDialogs = create<{ stack: Request[] }>(() => ({ stack: [] }));
let seq = 0;

function open(make: (id: number, finish: (v: string | null) => void) => Request): Promise<string | null> {
  return new Promise((resolve) => {
    const id = ++seq;
    const finish = (v: string | null) => {
      useInputDialogs.setState((s) => ({ stack: s.stack.filter((r) => r.id !== id) }));
      resolve(v);
    };
    useInputDialogs.setState((s) => ({ stack: [...s.stack, make(id, finish)] }));
  });
}

/** A text field dialog; resolves with the trimmed value, or null when cancelled. */
export function promptInput(options: PromptInputOptions): Promise<string | null> {
  return open((id, resolve) => ({ kind: "prompt", id, options, resolve }));
}

/** A list to pick one entry from; resolves with it, or null when cancelled. */
export function chooseItem(options: ChooseItemOptions): Promise<string | null> {
  return open((id, resolve) => ({ kind: "choose", id, options, resolve }));
}

export function InputDialogsHost() {
  const stack = useInputDialogs((s) => s.stack);
  return (
    <>
      {stack.map((r) =>
        r.kind === "prompt" ? (
          <PromptDialog key={r.id} options={r.options} done={r.resolve} />
        ) : (
          <ChooseDialog key={r.id} options={r.options} done={r.resolve} />
        ),
      )}
    </>
  );
}

const notBlank = (v: string) => (v.trim() ? null : "Value must not be empty");

function PromptDialog({ options, done }: { options: PromptInputOptions; done: (v: string | null) => void }) {
  const [value, setValue] = useState(options.initial ?? "");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState(options.error ?? null);
  const [pending, setPending] = useState(false);
  const validation = useRef<AbortController | null>(null);
  useEffect(() => () => validation.current?.abort(), []);
  const localError = (options.validate ?? notBlank)(value);
  const error = localError ?? serverError;
  const close = () => {
    validation.current?.abort();
    done(null);
  };
  const submit = async () => {
    setTouched(true);
    if (localError || validation.current) return;
    if (!options.submit) return done(value.trim());
    const controller = new AbortController();
    validation.current = controller;
    setPending(true);
    try {
      const message = await options.submit(value.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setServerError(message);
      if (!message) done(value.trim());
    } catch (e) {
      if (!controller.signal.aborted) setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) {
        validation.current = null;
        setPending(false);
      }
    }
  };
  return (
    <Dialog
      open
      title={options.title}
      onClose={close}
      width={420}
      buttons={[
        {
          label: options.okLabel ?? "OK",
          role: "default",
          disabled: !!localError || pending,
          onClick: () => void submit(),
        },
        { label: t("common.cancel"), role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {options.label && (
          <label className={styles.label}>
            <T>{options.label}</T>
          </label>
        )}
        <Input
          data-autofocus
          aria-label={options.label ?? options.title}
          value={value}
          placeholder={options.placeholder}
          disabled={pending}
          invalid={(touched || !!serverError) && !!error}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
            setServerError(null);
          }}
        />
        {(touched || !!serverError) && error && (
          <div className={styles.error}>
            <T>{error}</T>
          </div>
        )}
        {options.hint && <div className={styles.hint}>{options.hint}</div>}
      </form>
    </Dialog>
  );
}

function ChooseDialog({ options, done }: { options: ChooseItemOptions; done: (v: string | null) => void }) {
  const [active, setActive] = useState(0);
  const pick = options.items[active];
  return (
    <Dialog
      open
      title={options.title}
      onClose={() => done(null)}
      width={360}
      buttons={[
        { label: "OK", role: "default", disabled: pick === undefined, onClick: () => pick !== undefined && done(pick) },
        { label: t("common.cancel"), role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <List
          items={options.items}
          getKey={(item) => item}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(item) => done(item)}
          rowHeight={24}
          className={styles.list}
          aria-label={options.title}
          empty={
            <div className={styles.hint}>
              <T>{options.empty ?? "Nothing to choose from"}</T>
            </div>
          }
          renderItem={(item, state) => <div className={state.active ? styles.activeRow : styles.row}>{item}</div>}
        />
      </div>
    </Dialog>
  );
}
