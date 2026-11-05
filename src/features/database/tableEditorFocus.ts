/**
 * The table editor that has focus, for Submit / Revert (⌘↩ / ⌥⌘Z). Not while a text field has
 * it: ⌘↩ there applies the field's own edit (the Value panel, the cell editor).
 */
import { setContext } from "@/platform/context";

export interface TableEditorHandle {
  dirty: boolean;
  submit(): void;
  revert(): void;
}

const handles = new WeakMap<Element, TableEditorHandle>();
let active: TableEditorHandle | null = null;

const isTextField = (el: Element) => !!el.closest("input, textarea, select, [contenteditable='true']");

function update() {
  setContext("dbTableEditorFocus", !!active);
  setContext("dbTableEditorChanges", !!active?.dirty);
}

function onFocusIn(event: FocusEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const root = target?.closest("[data-db-table-editor]");
  active = (root && !isTextField(target!) && handles.get(root)) || null;
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

export function activeTableEditor(): TableEditorHandle | null {
  return active;
}

export function installTableEditorFocus(): () => void {
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    active = null;
    update();
  };
}
