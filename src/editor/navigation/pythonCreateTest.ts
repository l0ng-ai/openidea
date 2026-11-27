/** Create Test for a Python module: choose functions and methods, then write pytest stubs. */
import { EditorSelection } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { editorsFor, useEditorRegistry, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { pythonModulePath } from "@/editor/core/copyReference";
import { showHint } from "@/editor/lsp/hint";
import { chooseMembers } from "@/editor/lsp/memberChooser";
import { offsetToPos } from "@/editor/lsp/positions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { pytestStubEdit, pythonTestSubjects, subjectsAtLine } from "./pythonTests";

/** The text editor of `path` once its tab has mounted one (opening a file resolves before that). */
function editorOf(path: string, timeoutMs = 5000): Promise<TextEditorHandle | null> {
  const now = editorsFor(path)[0];
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (handle: TextEditorHandle | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(handle);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const unsubscribe = useEditorRegistry.subscribe(() => {
      const handle = editorsFor(path)[0];
      if (handle) done(handle);
    });
  });
}

export async function createPythonTest(
  view: EditorView,
  ctx: EditorDocContext,
  { existing, path }: { existing: string | null; path: string },
): Promise<void> {
  const subjects = pythonTestSubjects(await call(commands.docOutline(ctx.doc)));
  if (!subjects.length) return showHint(view, "No functions or methods to test");
  const caretLine = offsetToPos(view.state.doc, view.state.selection.main.head).line;
  const preselected = new Set(subjectsAtLine(subjects, caretLine).map((s) => s.id));
  const file = basename(ctx.path);
  const ids = await chooseMembers(view, {
    title: tx`Create Test for ${file}`,
    members: subjects.map((s) => ({
      id: s.id,
      label: `${s.name}()`,
      icon: s.cls ? "symbol-method" : "symbol-function",
      group: s.cls ?? file,
      checked: preselected.has(s.id),
    })),
  });
  if (!ids?.length) return;
  const chosen = subjects.filter((s) => ids.includes(s.id));

  const target = existing ?? path;
  // Go to Test found no test file, so `path` is new; one created meanwhile is used as it is.
  if (!existing) await call(commands.fsCreateFile(path)).catch(() => undefined);
  await editorService().openFile(target, { focus: true });
  const editor = await editorOf(target);
  if (!editor || editor.view.state.readOnly) return;
  const module = pythonModulePath(ctx.path, useProject.getState().project?.root ?? null);
  const state = editor.view.state;
  const edit = pytestStubEdit(state.doc.toString(), module, chosen, state.facet(indentUnit));
  if (!edit) return showHint(editor.view, "The chosen tests already exist");
  editor.view.dispatch({
    changes: edit.changes,
    selection: EditorSelection.cursor(edit.caret),
    scrollIntoView: true,
    userEvent: "input",
  });
  editor.view.focus();
}
