import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";

interface ValueEditorActions {
  reformat(): void;
  find(): void;
  openWindow?: () => void;
  readOnly: boolean;
}

const editors = new WeakMap<Element, ValueEditorActions>();
let active: ValueEditorActions | null = null;

function update() {
  setContext("dbJsonValueFocus", !!active);
  setContext("dbJsonValueEditable", !!active && !active.readOnly);
  setContext("dbJsonValueCanOpenWindow", !!active?.openWindow);
}

export function registerValueEditorActions(root: Element, actions: ValueEditorActions): () => void {
  editors.set(root, actions);
  return () => {
    editors.delete(root);
    if (active === actions) active = null;
    update();
  };
}

export function installValueEditorActions(): () => void {
  const onFocus = (event: FocusEvent) => {
    const root = event.target instanceof Element ? event.target.closest("[data-db-value-editor]") : null;
    active = root ? (editors.get(root) ?? null) : null;
    update();
  };
  document.addEventListener("focusin", onFocus);
  const dispose = registerActions([
    {
      id: "db.reformatValue",
      title: "Reformat",
      category: "Database",
      when: "dbJsonValueFocus && dbJsonValueEditable",
      run: () => active?.reformat(),
    },
    {
      id: "db.findInValue",
      title: "Find",
      category: "Database",
      when: "dbJsonValueFocus",
      run: () => active?.find(),
    },
    {
      id: "db.openValueWindow",
      title: "Open in Window",
      category: "Database",
      when: "dbJsonValueCanOpenWindow",
      run: () => active?.openWindow?.(),
    },
  ]);
  return () => {
    dispose();
    document.removeEventListener("focusin", onFocus);
    active = null;
    update();
  };
}
