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
import { registerHostPathChooser, type ChoosePathOptions } from "@/platform/choosePath";
import { t, tx, VerbatimTextContext } from "@/platform/i18n";
import { call, commands, type FileEntry } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Checkbox, Dialog, Given, Icon, IconButton, Input, List, T } from "@/ui";
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
  /** Closes the dialog as cancelled when aborted. */
  signal?: AbortSignal;
  /** Resolve with the text as typed instead of trimmed. */
  keepWhitespace?: boolean;
  /** A multi-line field: Enter adds a line, Cmd/Ctrl+Enter confirms. */
  multiline?: boolean;
  /** A password field (characters hidden). */
  secret?: boolean;
  /** Title, text and labels come from outside the IDE (a plugin) and are shown as written. */
  verbatim?: boolean;
}

export interface ChooseItemOptions {
  title: string;
  items: readonly string[];
  /** Shown when `items` is empty. */
  empty?: string;
}

export interface PickItemsOptions {
  title: string;
  items: readonly { key: string; label: string; description?: string | null }[];
  multiple: boolean;
  /** Closes the dialog as cancelled when aborted. */
  signal?: AbortSignal;
  /** Title, text and labels come from outside the IDE (a plugin) and are shown as written. */
  verbatim?: boolean;
}

type Request =
  | { kind: "prompt"; id: number; options: PromptInputOptions; resolve: (v: string | null) => void }
  | { kind: "choose"; id: number; options: ChooseItemOptions; resolve: (v: string | null) => void }
  | { kind: "pick"; id: number; options: PickItemsOptions; resolve: (v: string[] | null) => void }
  | { kind: "path"; id: number; options: ChoosePathOptions; resolve: (v: string | null) => void };

const useInputDialogs = create<{ stack: Request[] }>(() => ({ stack: [] }));
let seq = 0;

function open<T>(
  make: (id: number, finish: (v: T | null) => void) => Request,
  signal?: AbortSignal,
): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const id = ++seq;
    const finish = (v: T | null) => {
      signal?.removeEventListener("abort", cancel);
      useInputDialogs.setState((s) => ({ stack: s.stack.filter((r) => r.id !== id) }));
      resolve(v);
    };
    const cancel = () => finish(null);
    signal?.addEventListener("abort", cancel);
    useInputDialogs.setState((s) => ({ stack: [...s.stack, make(id, finish as never)] }));
  });
}

/** A text field dialog; resolves with the trimmed value, or null when cancelled. */
export function promptInput(options: PromptInputOptions): Promise<string | null> {
  return open<string>((id, resolve) => ({ kind: "prompt", id, options, resolve }), options.signal);
}

/** A list to pick one entry from; resolves with it, or null when cancelled. */
export function chooseItem(options: ChooseItemOptions): Promise<string | null> {
  return open<string>((id, resolve) => ({ kind: "choose", id, options, resolve }));
}

/** A list to pick one or more entries from; resolves with their keys, or null when cancelled. */
export function pickItems(options: PickItemsOptions): Promise<string[] | null> {
  return open<string[]>((id, resolve) => ({ kind: "pick", id, options, resolve }), options.signal);
}

/** A file or folder on the host this window's commands run on, browsed in the IDE (a remote window's chooser). */
export function choosePathOnHost(options: ChoosePathOptions): Promise<string | null> {
  return open<string>((id, resolve) => ({ kind: "path", id, options, resolve }));
}

registerHostPathChooser(choosePathOnHost);

export function InputDialogsHost() {
  const stack = useInputDialogs((s) => s.stack);
  return (
    <>
      {stack.map((r) =>
        r.kind === "prompt" ? (
          <VerbatimTextContext.Provider key={r.id} value={!!r.options.verbatim}>
            <PromptDialog options={r.options} done={r.resolve} />
          </VerbatimTextContext.Provider>
        ) : r.kind === "choose" ? (
          <ChooseDialog key={r.id} options={r.options} done={r.resolve} />
        ) : r.kind === "path" ? (
          <PathDialog key={r.id} options={r.options} done={r.resolve} />
        ) : (
          <VerbatimTextContext.Provider key={r.id} value={!!r.options.verbatim}>
            <PickDialog options={r.options} done={r.resolve} />
          </VerbatimTextContext.Provider>
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
    const result = options.keepWhitespace ? value : value.trim();
    if (!options.submit) return done(result);
    const controller = new AbortController();
    validation.current = controller;
    setPending(true);
    try {
      const message = await options.submit(result, controller.signal);
      if (controller.signal.aborted) return;
      setServerError(message);
      if (!message) done(result);
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
      blockWorkbenchShortcuts
      title={options.title}
      onClose={close}
      width={420}
      buttons={[
        {
          label: options.okLabel ?? tx("OK"),
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
            <Given>{options.label}</Given>
          </label>
        )}
        {options.multiline ? (
          <textarea
            data-autofocus
            aria-label={options.label ?? options.title}
            className={styles.area}
            rows={5}
            value={value}
            placeholder={options.placeholder}
            disabled={pending}
            aria-invalid={(touched || !!serverError) && !!error}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                void submit();
              }
            }}
            onChange={(e) => {
              setTouched(true);
              setValue(e.target.value);
              setServerError(null);
            }}
          />
        ) : (
          <Input
            data-autofocus
            aria-label={options.label ?? options.title}
            type={options.secret ? "password" : undefined}
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
        )}
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
      blockWorkbenchShortcuts
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

function PickDialog({ options, done }: { options: PickItemsOptions; done: (v: string[] | null) => void }) {
  const [active, setActive] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const picked = options.multiple ? options.items.filter((i) => checked.has(i.key)).map((i) => i.key) : [];
  const activeKey = options.items[active]?.key;
  const confirm = () => {
    if (options.multiple) return done(picked);
    if (activeKey !== undefined) done([activeKey]);
  };
  return (
    <Dialog
      open
      blockWorkbenchShortcuts
      title={options.title}
      onClose={() => done(null)}
      width={420}
      buttons={[
        {
          label: tx("OK"),
          role: "default",
          disabled: options.multiple ? false : activeKey === undefined,
          onClick: confirm,
        },
        { label: t("common.cancel"), role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <List
          items={options.items}
          getKey={(item) => item.key}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(item, _index, e) => {
            if (!options.multiple) return done([item.key]);
            if (e.type === "keydown") toggle(item.key);
          }}
          rowHeight={options.items.some((i) => i.description) ? 36 : 24}
          className={styles.list}
          aria-label={options.title}
          empty={
            <div className={styles.hint}>
              <T>Nothing to choose from</T>
            </div>
          }
          renderItem={(item, state) => (
            <div className={state.active ? styles.activeRow : styles.row}>
              {options.multiple ? (
                <Checkbox checked={checked.has(item.key)} onChange={() => toggle(item.key)} label={item.label} />
              ) : (
                item.label
              )}
              {item.description && <div className={styles.hint}>{item.description}</div>}
            </div>
          )}
        />
      </div>
    </Dialog>
  );
}

/** The folder that holds `path` (either separator), or null at a root. */
export function parentPath(path: string): string | null {
  if (/^(?:[\\/]+|[A-Za-z]:[\\/]*)$/.test(path)) return null;
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  const parent = trimmed.slice(0, cut);
  // `/a` → `/`; `C:\a` → `C:\`.
  if (!parent || /^[A-Za-z]:$/.test(parent)) return parent + trimmed[cut];
  return parent === trimmed ? null : parent;
}

function PathDialog({ options, done }: { options: ChoosePathOptions; done: (v: string | null) => void }) {
  const root = useProject((s) => s.project?.root ?? null);
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [active, setActive] = useState(-1);
  const [value, setValue] = useState(options.defaultPath || root || "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const isDir = (e: FileEntry) => e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir");
  const visit = async (path: string) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const listed = await call(commands.fsReadDir(path));
      if (id !== request.current) return true;
      const shown = listed
        .filter((e) => !options.directory || isDir(e))
        .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
      setDir(path);
      setEntries(shown);
      setActive(-1);
      setValue(path);
      setError(null);
      return true;
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    const start = options.defaultPath || root || "/";
    // A file path starts in its folder, with the file in the field.
    void visit(start).then((ok) => {
      const parent = parentPath(start);
      if (!ok && parent) void visit(parent).then((found) => found && !options.directory && setValue(start));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (entry: FileEntry) => {
    if (isDir(entry)) void visit(entry.path);
    else done(entry.path);
  };
  const submit = async () => {
    const path = value.trim();
    if (!path) return;
    let kind: string;
    try {
      kind = await call(commands.fsEntryKind(path));
    } catch {
      return setError(tx("No such file or folder"));
    }
    const folder = kind === "dir";
    if (options.directory) return folder ? done(path) : setError(tx("Choose a folder"));
    if (folder) return void visit(path);
    done(path);
  };
  const up = dir === null ? null : parentPath(dir);

  return (
    <Dialog
      open
      blockWorkbenchShortcuts
      title={options.title}
      onClose={() => done(null)}
      width={520}
      buttons={[
        { label: tx("OK"), role: "default", disabled: !value.trim(), onClick: () => void submit() },
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
        <div className={styles.pathRow}>
          <IconButton
            icon="arrow-up"
            title={tx("Parent Folder")}
            disabled={!up || loading}
            onClick={() => up && void visit(up)}
          />
          <Input
            data-autofocus
            className={styles.pathInput}
            aria-label={options.title}
            value={value}
            invalid={!!error}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </div>
        <List
          items={entries}
          getKey={(e) => e.path}
          activeIndex={active}
          onActiveChange={(i) => {
            setActive(i);
            const entry = entries[i];
            if (entry) setValue(entry.path);
          }}
          // A click selects; a double click or Enter opens the folder or chooses the file.
          onActivate={(entry, _i, e) => (e.type !== "click" || e.detail > 1) && choose(entry)}
          rowHeight={24}
          className={styles.pathList}
          aria-label={dir ?? options.title}
          empty={
            <div className={styles.hint}>
              <T>{loading ? "Loading…" : "Empty folder"}</T>
            </div>
          }
          renderItem={(entry, state) => (
            <div className={`${state.active ? styles.activeRow : styles.row} ${styles.entry}`}>
              <Icon name={isDir(entry) ? "folder" : "file"} />
              <span className={styles.entryName}>{entry.name}</span>
            </div>
          )}
        />
        {error && (
          <div className={styles.error}>
            <T>{error}</T>
          </div>
        )}
      </form>
    </Dialog>
  );
}
