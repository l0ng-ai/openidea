/**
 * Navigate › Test / Test Subject (⇧⌘T), Super Method (⌘U), Next / Previous
 * Method (⌃⇧↓ / ⌃⇧↑). Editor-side like editor/lsp (whose popups it uses);
 * the file templates are reached through the `templates.newFromTemplate` action.
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { activeEditor, editorsFor, whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf, lspRequest } from "@/editor/lsp/lsp";
import { offsetToPos, posToOffset } from "@/editor/lsp/positions";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { dedupeLocations, locationItems, navigateTo } from "@/editor/lsp/navigation";
import { showHint } from "@/editor/lsp/hint";
import { registerActions, executeAction, type Action } from "@/platform/actions";
import { call, commands, isCancelled, type Location, type OutlineItem, type Pos } from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { currentRoots } from "@/platform/projectRoots";
import { isVirtualUri } from "@/platform/virtualDocs";
import { editorService } from "@/workbench/contributions";
import { fileIconName } from "@/ui";
import { gotoTestOrSubject, type TestNavDeps } from "./gotoTest";
import { projectPythonHierarchy, pythonSuperDeps } from "./pythonHierarchy";
import { baseName, memberAt, methodStop, superMethods, type SuperDeps } from "./structureNav";
import { tx } from "@/platform/i18n";

const EDITOR_WHEN = "textEditorActive && (editorFocus || !toolWindowFocus)";

/** A backend document id for `path` while `fn` runs (open editors are reused). */
async function withDoc<T>(path: string, fn: (doc: number) => Promise<T>): Promise<T> {
  const open = editorsFor(path)[0];
  if (open) return fn(open.ctx.doc);
  const info = await call(isVirtualUri(path) ? commands.docOpenVirtual(path) : commands.docOpen(path));
  try {
    return await fn(info.id);
  } finally {
    void commands.docClose(info.id);
  }
}

const outlineOf = (doc: number) => lspRequest(() => commands.docOutline(doc));

async function caretOutline(
  view: EditorView,
  ctx: EditorDocContext,
): Promise<{ outline: OutlineItem[]; caret: Pos } | null> {
  await whenSynced(view);
  const caret = offsetToPos(view.state.doc, view.state.selection.main.head);
  try {
    return { outline: await outlineOf(ctx.doc), caret };
  } catch (e) {
    if (!isCancelled(e)) showHint(view, "No structure information for this file");
    return null;
  }
}

async function gotoMethod(view: EditorView, dir: 1 | -1) {
  const ctx = docOf(view);
  if (!ctx) return;
  const at = await caretOutline(view, ctx);
  if (!at) return;
  const target = methodStop(at.outline, at.caret, dir);
  if (!target) return;
  const pos = posToOffset(view.state.doc, target);
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "select.navigate" });
}

/** Without a type hierarchy: languages whose servers answer "super" through another request. */
async function superFallback(ctx: EditorDocContext, pos: Pos): Promise<Location[]> {
  const kind = ctx.language === "go" ? "implementation" : ctx.language === "rust" ? "declaration" : null;
  if (!kind) return [];
  const locs = await lspRequest(() => commands.lspGoto(ctx.doc, pos, kind)).catch(() => [] as Location[]);
  return dedupeLocations(locs).filter((l) => !(l.path === ctx.path && l.range.start.line === pos.line));
}

/** Super Method deps: Python answers them from the IDE's inheritance graph (its servers have no type hierarchy). */
async function superDeps(ctx: EditorDocContext): Promise<SuperDeps> {
  const outline = (path: string) => withDoc(path, outlineOf);
  if (ctx.language === "python") {
    const hierarchy = await projectPythonHierarchy().catch(() => null);
    if (hierarchy) return pythonSuperDeps(hierarchy, outline);
  }
  return {
    supertypes: (path: string, pos: Pos) =>
      withDoc(path, (doc) => lspRequest(() => commands.lspTypeHierarchy(doc, pos, "incoming"))),
    outline,
  };
}

async function superMethod(view: EditorView) {
  const ctx = docOf(view);
  if (!ctx) return;
  const at = await caretOutline(view, ctx);
  if (!at) return;
  const { method, type } = memberAt(at.outline, at.caret);
  const deps = await superDeps(ctx);
  let locs: Location[] = [];
  if (method && type) locs = await superMethods(ctx.path, type.selection_range.start, method.name, deps);
  else if (type) {
    const supers = await deps.supertypes(ctx.path, type.selection_range.start).catch(() => []);
    locs = supers.map((s) => ({ path: s.path, range: s.selectionRange, uri: s.uri ?? null }));
  }
  if (!locs.length && method) locs = await superFallback(ctx, method.selection_range.start);
  locs = dedupeLocations(locs);
  const head = view.state.selection.main.head;
  if (!locs.length) {
    showHint(view, method ? "No super method found" : "No super class found");
    return;
  }
  if (locs.length === 1) {
    await navigateTo(locs[0]!);
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, head),
    title: method
      ? tx`Choose Super Method of ${baseName(method.name)} (${locs.length} found)`
      : tx`Choose Super Class or Interface (${locs.length} found)`,
    items: await locationItems(locs),
  });
}

const RUST_TEST_MODULE =
  "\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn it_works() {\n        \n    }\n}\n";

function testDeps(view: EditorView, ctx: EditorDocContext): TestNavDeps {
  return {
    projectRoot: () => useProject.getState().project?.root ?? null,
    roots: () => currentRoots(),
    findByName: async (name) =>
      (await call(commands.findFiles(name, 50))).filter((m) => basename(m.path) === name).map((m) => m.path),
    open: async (path, offset) => {
      const selection = offset !== undefined && path === ctx.path ? offsetToPos(view.state.doc, offset) : undefined;
      await editorService().openFile(path, { selection, focus: true });
    },
    choose: (title, items) =>
      openPopup({
        kind: "list",
        anchor: caretAnchor(view, view.state.selection.main.head),
        title,
        items: items.map((it, i) => ({
          id: `${i}`,
          label: it.label,
          detail: it.detail,
          emphasis: it.emphasis,
          icon: it.emphasis ? "plus" : fileIconName(it.label),
          run: it.run,
        })),
      }),
    hint: (text) => showHint(view, text),
    createTest: ({ directory, name, extension }) =>
      void executeAction("templates.newFromTemplate", { directory, name, extension, kindId: "test" }),
    createRustTestModule: () => {
      if (view.state.readOnly) return;
      const end = view.state.doc.length;
      const insert = (view.state.doc.sliceString(end - 1) === "\n" ? "" : "\n") + RUST_TEST_MODULE;
      const caret = end + insert.indexOf("fn it_works() {\n") + "fn it_works() {\n        ".length;
      view.dispatch({
        changes: { from: end, insert },
        selection: EditorSelection.cursor(caret),
        scrollIntoView: true,
        userEvent: "input",
      });
      view.focus();
    },
  };
}

async function gotoTest(view: EditorView) {
  const ctx = docOf(view);
  if (!ctx || isVirtualUri(ctx.path)) return;
  try {
    await gotoTestOrSubject(ctx.path, view.state.doc.toString(), testDeps(view, ctx));
  } catch (e) {
    if (!isCancelled(e)) showHint(view, e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}

function editorAction(
  id: string,
  title: string,
  run: (view: EditorView) => unknown,
  extra: Partial<Action> = {},
): Action {
  return {
    id,
    title,
    category: "Navigate",
    when: EDITOR_WHEN,
    run: () => {
      const ed = activeEditor();
      if (ed) void run(ed.view);
    },
    ...extra,
  };
}

export function registerNavigationActions(): () => void {
  return registerActions([
    editorAction("navigate.gotoTest", "Test", gotoTest, { keywords: ["go to test", "test subject", "create test"] }),
    editorAction("navigate.superMethod", "Super Method", superMethod, {
      keywords: ["go to super", "overridden", "parent"],
    }),
    editorAction("navigate.nextMethod", "Next Method", (v) => gotoMethod(v, 1)),
    editorAction("navigate.previousMethod", "Previous Method", (v) => gotoMethod(v, -1)),
  ]);
}

export { implementationGutter } from "./implementationGutter";
