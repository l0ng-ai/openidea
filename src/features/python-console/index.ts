/** Python Console: an interactive interpreter of the project's Python, fed from the editor too. */
import { activeEditor } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { lazyComponent } from "@/ui";
import { registerMenuGroup, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { execute, installConsole } from "./store";

const ID = "pythonConsole";

/** The selection, or the caret's line when nothing is selected. */
function editorCode(): string | null {
  const handle = activeEditor();
  if (!handle) return null;
  const { state } = handle.view;
  const sel = state.selection.main;
  return sel.empty ? state.doc.lineAt(sel.head).text : state.sliceDoc(sel.from, sel.to);
}

export function activate(): () => void {
  const disposers = [
    installConsole(),
    registerToolWindow({
      id: ID,
      title: "Python Console",
      icon: "file-python",
      anchor: "bottom",
      // Listed under the stripe's "…" until first opened: most projects are not Python ones.
      stripe: "onUse",
      order: 27,
      component: lazyComponent(() => import("./ConsoleView").then((m) => m.ConsoleView)),
    }),
    registerActions([
      {
        id: "python.console.show",
        title: "Python Console",
        category: "Tools",
        when: "projectOpen",
        run: () => toolWindowService().show(ID, true),
      },
      {
        id: "python.console.executeSelection",
        title: "Execute Selection in Python Console",
        category: "Tools",
        when: "editorLangId == python",
        keyWhen: "editorTextFocus",
        run: () => {
          const code = editorCode();
          if (!code?.trim()) return;
          toolWindowService().show(ID, false);
          execute(code);
        },
      },
    ]),
    registerMenuGroup({
      id: "pythonConsole.editor",
      menus: ["editor"],
      order: 45,
      items: () =>
        getContext().editorLangId === "python" ? [{ kind: "action", action: "python.console.executeSelection" }] : [],
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
