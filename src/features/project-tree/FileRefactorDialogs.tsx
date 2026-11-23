/**
 * IDEA's Rename (⇧F6), Move (F6, drag & drop, cut & paste) and Copy (copy &
 * paste, ⌥ drag) dialogs for files and folders, with "Search for references"
 * and "Search in comments and strings".
 */
import { useEffect, useRef, useState, type Ref } from "react";
import { create } from "zustand";
import type { FileMove } from "@/bindings";
import { Checkbox, Dialog, IconButton, Input, Spinner, T } from "@/ui";
import { choosePath } from "@/platform/choosePath";
import { isTauri } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { runFileRefactoring, type FileRefactorOptions } from "./fileRefactor";
import {
  isSameOrInside,
  joinPath,
  nameOf,
  parentOf,
  relativeTo,
  splitExtension,
  uniqueName,
  validateName,
} from "./paths";
import { useProjectTree } from "./store";
import styles from "./FileRefactor.module.css";
import { tx } from "@/platform/i18n";
import { hostOs } from "@/platform/remote";

export type FileRefactorRequest =
  | {
      kind: "rename";
      path: string;
      dir: boolean;
      siblings: string[];
      onDone?: (moves: FileMove[]) => void;
    }
  | {
      kind: "move";
      paths: string[];
      /** Initial target folder. */
      target: string;
      /** The single moved item is a folder. */
      dir?: boolean;
      /** Called after the files moved (tree refresh / reveal). */
      onDone?: (moves: FileMove[]) => void;
    }
  | {
      kind: "copy";
      paths: string[];
      /** Initial target folder. */
      target: string;
      /** The single copied item is a folder. */
      dir?: boolean;
      /** Copies into `target` (`name`: the single item's new name); false keeps the dialog open. */
      copy: (target: string, name: string | null, openInEditor: boolean) => Promise<boolean>;
    };

const useRequest = create<{ request: (FileRefactorRequest & { seq: number }) | null }>(() => ({ request: null }));
let seq = 0;

export function openFileRefactorDialog(request: FileRefactorRequest) {
  useRequest.setState({ request: { ...request, seq: ++seq } });
}

export function closeFileRefactorDialog() {
  useRequest.setState({ request: null });
}

/** Test hook: the open dialog's request. */
export function pendingFileRefactorDialog(): FileRefactorRequest | null {
  return useRequest.getState().request;
}

// ---------------------------------------------------------------------------
// Remembered options (IDEA keeps the last choice per dialog)

const OPTIONS_KEY = "openidea.projectTree.refactorOptions";
interface StoredOptions extends FileRefactorOptions {
  openInEditor: boolean;
}
const DEFAULT_OPTIONS: StoredOptions = { references: true, textOccurrences: true, openInEditor: false };

function loadOptions(kind: string): StoredOptions {
  try {
    const raw = localStorage.getItem(`${OPTIONS_KEY}.${kind}`);
    return raw ? { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<StoredOptions>) } : DEFAULT_OPTIONS;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function saveOptions(kind: string, o: StoredOptions) {
  try {
    localStorage.setItem(`${OPTIONS_KEY}.${kind}`, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

const caseInsensitive = typeof navigator !== "undefined" && /Mac|Win/i.test(navigator.userAgent);

// ---------------------------------------------------------------------------

function useSearch() {
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = async (moves: FileMove[], options: FileRefactorOptions, label: "Move" | "Rename") => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    try {
      return await runFileRefactoring(moves, options, label, {
        signal: ctrl.signal,
        onSearched: () => {
          // The search is over: closing the dialog must not cancel the refactoring.
          abort.current = null;
          closeFileRefactorDialog();
        },
      });
    } finally {
      setBusy(false);
      if (abort.current === ctrl) abort.current = null;
    }
  };
  const cancel = () => {
    abort.current?.abort();
    closeFileRefactorDialog();
  };
  return { busy, run, cancel };
}

function Options({
  value,
  onChange,
  move,
  disabled,
}: {
  value: StoredOptions;
  onChange: (o: StoredOptions) => void;
  move: boolean;
  disabled: boolean;
}) {
  return (
    <div className={move ? styles.options : styles.renameOptions}>
      <Checkbox
        label="Search for references"
        checked={value.references}
        disabled={disabled}
        onChange={(references) => onChange({ ...value, references })}
      />
      <Checkbox
        label="Search in comments and strings"
        checked={value.textOccurrences}
        disabled={disabled}
        onChange={(textOccurrences) => onChange({ ...value, textOccurrences })}
      />
      {move && (
        <Checkbox
          label="Open moved files in editor"
          checked={value.openInEditor}
          disabled={disabled}
          onChange={(openInEditor) => onChange({ ...value, openInEditor })}
        />
      )}
    </div>
  );
}

function Busy() {
  return (
    <div className={styles.busy} role="status">
      <Spinner size={14} />
      <span>
        <T>Looking for references…</T>
      </span>
    </div>
  );
}

function RenameDialog({ request }: { request: Extract<FileRefactorRequest, { kind: "rename" }> }) {
  const current = nameOf(request.path);
  const [name, setName] = useState(current);
  const [options, setOptions] = useState(() => loadOptions("rename"));
  const input = useRef<HTMLInputElement>(null);
  const { busy, run, cancel } = useSearch();
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // IDEA selects the name without the extension.
    const stem = request.dir ? current : splitExtension(current)[0];
    el.setSelectionRange(0, stem.length || current.length);
  }, [current, request.dir]);
  const check = validateName(name, {
    siblings: request.siblings,
    current,
    caseInsensitive,
    windows: hostOs() === "windows",
  });
  const error = name === current ? null : check.error;
  const submit = () => {
    if (busy || error) return;
    if (name === current) {
      closeFileRefactorDialog();
      return;
    }
    saveOptions("rename", options);
    const moves = [{ from: request.path, to: joinPath(parentOf(request.path), name) }];
    void run(moves, options, "Rename").then((status) => status === "done" && request.onDone?.(moves));
  };
  return (
    <Dialog
      open
      title="Rename"
      onClose={cancel}
      width={460}
      footerStart={busy ? <Busy /> : undefined}
      buttons={[
        { label: "Refactor", role: "default", disabled: busy || !!error, onClick: submit },
        { label: "Cancel", role: "cancel", onClick: cancel },
      ]}
    >
      <form
        className={styles.renameForm}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={styles.renameName}>
          <label className={styles.fieldLabel} htmlFor="file-rename-name">
            {request.dir
              ? tx`Rename directory '${current}' and its usages to:`
              : tx`Rename file '${current}' and its usages to:`}
          </label>
          <Input
            id="file-rename-name"
            ref={input}
            value={name}
            disabled={busy}
            invalid={!!error}
            aria-label="New name"
            onChange={(e) => setName(e.target.value)}
          />
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
        </div>
        <Options value={options} onChange={setOptions} move={false} disabled={busy} />
      </form>
    </Dialog>
  );
}

/** Folder `typed` (absolute, or relative to the project root). */
function resolveTarget(typed: string, root: string): string {
  const value = ipcPath(typed.trim());
  if (!value) return root;
  const absolute = value.startsWith("/") || /^[A-Za-z]:\//.test(value);
  const isRoot = /^(?:[A-Za-z]:)?\/+$/.test(value);
  const path = value.replace(/\/+$/, isRoot ? "/" : "");
  return absolute ? path : joinPath(root, path);
}

function useDestination(initialTarget: string) {
  const root = useProjectTree((s) => s.root) ?? "";
  const [target, setTarget] = useState(initialTarget);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const dest = resolveTarget(target, root);
  const change = (value: string) => {
    setBrowseError(null);
    setTarget(value);
  };
  const browse = async () => {
    setBrowsing(true);
    setBrowseError(null);
    try {
      const picked = await choosePath({ directory: true, title: tx("Select Target Directory"), defaultPath: dest });
      if (picked !== null) setTarget(ipcPath(picked));
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowsing(false);
    }
  };
  return { target, dest, root, change, browse, browsing, browseError };
}

function DestinationField({
  id,
  destination,
  inputRef,
  disabled,
  invalid,
  focus,
}: {
  id: string;
  destination: ReturnType<typeof useDestination>;
  inputRef?: Ref<HTMLInputElement>;
  disabled: boolean;
  invalid?: boolean;
  focus?: boolean;
}) {
  const { target, dest, root, change, browse, browsing } = destination;
  const previewId = `${id}-preview`;
  return (
    <>
      <div className={styles.destinationField}>
        <Input
          id={id}
          ref={inputRef}
          data-autofocus={focus || undefined}
          mono
          value={target}
          disabled={disabled}
          invalid={invalid}
          aria-label="Target directory"
          aria-describedby={previewId}
          onChange={(e) => change(e.target.value)}
        />
        {isTauri() && (
          <IconButton
            icon="folder-open"
            title={tx("Browse for target directory")}
            disabled={disabled || browsing}
            onClick={() => void browse()}
          />
        )}
      </div>
      <div className={styles.destinationPath} id={previewId} title={dest}>
        {relativeTo(root, dest) || (dest === root ? tx("Project root") : dest)}
      </div>
    </>
  );
}

function MoveDialog({ request }: { request: Extract<FileRefactorRequest, { kind: "move" }> }) {
  const destination = useDestination(request.target);
  const { dest, browsing, browseError } = destination;
  const [options, setOptions] = useState(() => loadOptions("move"));
  const field = useRef<HTMLInputElement>(null);
  const { busy, run, cancel } = useSearch();
  useEffect(() => {
    const input = field.current;
    const path = request.target.replace(/[\\/]+$/, "");
    if (!input || !path || /^[A-Za-z]:$/.test(path)) return;
    const start = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
    input.setSelectionRange(start, path.length);
    input.scrollLeft = input.scrollWidth;
  }, [request.target]);
  const moves: FileMove[] = request.paths
    .map((from) => ({ from, to: joinPath(dest, nameOf(from)) }))
    .filter((move) => move.from !== move.to);
  const error = request.paths.some((p) => isSameOrInside(dest, p))
    ? tx("Cannot move a folder into itself")
    : !moves.length
      ? tx("Already in this directory")
      : null;
  const single = request.paths.length === 1 ? request.paths[0]! : null;
  const subject = single
    ? request.dir || useProjectTree.getState().listings.has(single)
      ? tx`Move directory '${nameOf(single)}'`
      : tx`Move file '${nameOf(single)}'`
    : tx`Move ${request.paths.length} items`;
  const submit = async () => {
    if (busy || browsing || error) return;
    saveOptions("move", options);
    const status = await run(moves, options, "Move");
    if (status !== "done") return;
    request.onDone?.(moves);
  };
  return (
    <Dialog
      open
      title="Move"
      onClose={cancel}
      width={520}
      footerStart={busy ? <Busy /> : undefined}
      buttons={[
        { label: "Refactor", role: "default", disabled: busy || browsing || !!error, onClick: () => void submit() },
        { label: "Cancel", role: "cancel", onClick: cancel },
      ]}
    >
      <form
        className={styles.refactorForm}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={styles.subject}>{subject}</div>
        <div className={styles.moveDestination}>
          <label className={styles.fieldLabel} htmlFor="file-move-target">
            <T>To directory:</T>
          </label>
          <div className={styles.destinationControls}>
            <DestinationField
              id="file-move-target"
              destination={destination}
              inputRef={field}
              disabled={busy}
              invalid={!!error}
              focus
            />
            {(browseError ?? error) && (
              <div className={styles.error} role="alert">
                {browseError ?? error}
              </div>
            )}
            <Options value={options} onChange={setOptions} move disabled={busy} />
          </div>
        </div>
      </form>
    </Dialog>
  );
}

const COPY_OPEN_KEY = "openidea.projectTree.copyOpenInEditor";

function CopyDialog({ request }: { request: Extract<FileRefactorRequest, { kind: "copy" }> }) {
  const destination = useDestination(request.target);
  const { dest, browsing, browseError } = destination;
  const single = request.paths.length === 1 ? request.paths[0]! : null;
  const listing = useProjectTree((s) => s.listings.get(dest));
  const [name, setName] = useState(() => {
    const own = single ? nameOf(single) : "";
    const taken = new Set((useProjectTree.getState().listings.get(request.target) ?? []).map((e) => fold(e.name)));
    return single ? uniqueName(own, (n) => taken.has(fold(n)), !!request.dir) : "";
  });
  const [openInEditor, setOpenInEditor] = useState(() => {
    try {
      return localStorage.getItem(COPY_OPEN_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const stem = request.dir ? name : splitExtension(name)[0];
    el.setSelectionRange(0, stem.length || name.length);
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const siblings = (listing ?? []).map((e) => e.name);
  const error = request.paths.some((p) => isSameOrInside(dest, p) && dest !== parentOf(p))
    ? "Cannot copy a folder into itself"
    : single
      ? validateName(name, { siblings, caseInsensitive, windows: hostOs() === "windows" }).error
      : null;
  const sourceName = single ? nameOf(single) : null;
  const count = request.paths.length;
  const subject = sourceName
    ? request.dir
      ? tx`Copy directory '${sourceName}'`
      : tx`Copy file '${sourceName}'`
    : tx`Copy ${count} items`;
  const submit = async () => {
    if (busy || browsing || error) return;
    try {
      localStorage.setItem(COPY_OPEN_KEY, String(openInEditor));
    } catch {
      /* storage unavailable */
    }
    setBusy(true);
    const ok = await request.copy(dest, single ? name : null, openInEditor && !request.dir);
    setBusy(false);
    if (ok) closeFileRefactorDialog();
  };
  return (
    <Dialog
      open
      title="Copy"
      onClose={closeFileRefactorDialog}
      width={520}
      footerStart={
        single &&
        !request.dir && (
          <Checkbox label="Open copy in editor" checked={openInEditor} disabled={busy} onChange={setOpenInEditor} />
        )
      }
      buttons={[
        { label: "OK", role: "default", disabled: busy || browsing || !!error, onClick: () => void submit() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.refactorForm}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={styles.subject}>{subject}</div>
        <div className={styles.copyFields}>
          {single && (
            <>
              <label className={styles.fieldLabel} htmlFor="file-copy-name">
                <T>New name:</T>
              </label>
              <Input
                id="file-copy-name"
                ref={input}
                value={name}
                disabled={busy}
                invalid={!!error}
                aria-label="New name"
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}
          <label className={styles.fieldLabel} htmlFor="file-copy-target">
            <T>To directory:</T>
          </label>
          <div className={styles.destinationControls}>
            <DestinationField id="file-copy-target" destination={destination} disabled={busy} focus={!single} />
            {(browseError ?? error) && (
              <div className={styles.error} role="alert">
                {browseError ?? error}
              </div>
            )}
          </div>
        </div>
      </form>
    </Dialog>
  );
}

const fold = (n: string) => (caseInsensitive ? n.toLowerCase() : n);

/** Overlay contribution rendering the open Rename / Move / Copy dialog. */
export function FileRefactorDialogHost() {
  const request = useRequest((s) => s.request);
  if (!request) return null;
  return request.kind === "rename" ? (
    <RenameDialog key={request.seq} request={request} />
  ) : request.kind === "move" ? (
    <MoveDialog key={request.seq} request={request} />
  ) : (
    <CopyDialog key={request.seq} request={request} />
  );
}

/** The options last used in the Rename / Move dialog (for moves without a dialog: cut & paste). */
export function rememberedOptions(kind: "rename" | "move"): StoredOptions {
  return loadOptions(kind);
}
