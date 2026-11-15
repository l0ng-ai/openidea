/**
 * The table editor or editable result grid that has focus, for Submit / Revert (⌘↩ / ⌥⌘Z) and Go to
 * Column (⌘F12). Not while a text field has it: ⌘↩ there applies the field's own edit (the Value
 * panel, the multi-line editor). The grid's inline cell editor counts as the grid: the cell is confirmed first.
 */
import { flushSync } from "react-dom";
import { setContext } from "@/platform/context";

/** Toolbar and row commands of a table editor or result grid, run as `db.*` actions. */
export type TableCommand =
  | "reload"
  | "firstPage"
  | "previousPage"
  | "nextPage"
  | "lastPage"
  | "addRow"
  | "exportData"
  | "deleteRows"
  | "restoreRows";

export interface TableCommandHandler {
  enabled(rows: number[]): boolean;
  /** `rows`: the grid's selected rows (row commands). */
  run(rows: number[]): void;
}

/** What a row menu passes to a `db.*` row action: the menu holds focus, not the grid. */
export interface TableCommandTarget {
  rows: number[];
  editor: TableEditorHandle | null;
}

export interface TableEditorHandle {
  dirty: boolean;
  submit(): void;
  revert(): void;
  showColumns(): void;
  /** The commands this view has; one it lacks is disabled. */
  commands?: Partial<Record<TableCommand, TableCommandHandler>>;
}

const handles = new WeakMap<Element, TableEditorHandle>();
let active: TableEditorHandle | null = null;
let editingCell = false;

const isCellEditor = (el: Element) => el.matches("[data-cell-editor]");
const isTextField = (el: Element) =>
  !isCellEditor(el) && !!el.closest("input, textarea, select, [contenteditable='true']");

function update() {
  setContext("dbTableEditorFocus", !!active);
  setContext("dbTableEditorChanges", !!active && (active.dirty || editingCell));
}

function onFocusIn(event: FocusEvent) {
  const target = event.target instanceof Element ? event.target : null;
  // The editor area focuses its host `[data-editor-focus]` when the tab opens —
  // treat that as focus inside a table editor so ⌘F12 / ⌘↩ work right away.
  const root =
    target?.closest("[data-db-table-editor]") ??
    (target?.hasAttribute("data-editor-focus") ? target.querySelector("[data-db-table-editor]") : null);
  active = (root && !isTextField(target!) && handles.get(root)) || null;
  editingCell = !!active && isCellEditor(target!);
  update();
}

/** Registers the editor rooted at `root`; returns the function that unregisters it. */
export function registerTableEditor(root: Element, handle: TableEditorHandle): () => void {
  handles.set(root, handle);
  if (root.contains(document.activeElement) && !isTextField(document.activeElement!)) active = handle;
  update();
  return () => {
    handles.delete(root);
    if (active === handle) active = null;
    update();
  };
}

/** The handle's state changed (pending edits). */
export function tableEditorChanged(handle: TableEditorHandle) {
  if (active === handle) update();
}

/** The active editor as is, for enablement checks (no side effects). */
export function focusedTableEditor(): TableEditorHandle | null {
  return active;
}

/** The active editor, after confirming the cell being edited so its value counts. */
export function activeTableEditor(): TableEditorHandle | null {
  const el = document.activeElement;
  if (active && el instanceof HTMLElement && isCellEditor(el)) flushSync(() => el.blur());
  return active;
}

export function installTableEditorFocus(): () => void {
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    active = null;
    editingCell = false;
    update();
  };
}
