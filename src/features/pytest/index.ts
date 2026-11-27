/**
 * pytest fixtures: Go to Declaration on a fixture name (a test's or fixture's parameter, a
 * `usefixtures` / `getfixturevalue` string) opens the fixture pytest uses, and completion
 * offers the visible fixtures there. Resolution (conftest.py files, plugins, pytest's own
 * fixtures) is the backend's (`navPytestFixtures`); the language server knows none of it.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  registerEditorContribution,
  registerNavigationProvider,
  whenSynced,
  type EditorDocContext,
} from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetToPos, posToOffset } from "@/editor/lsp/positions";
import { call, commands, isTauri, type PytestFixtureAt } from "@/platform/ipc";
import { useProject } from "@/platform/project";

/** The fixtures at `offset`, once the backend has the editor's text; null when the text changed meanwhile. */
async function fixturesAt(view: EditorView, doc: number, offset: number): Promise<PytestFixtureAt | null> {
  const text = view.state.doc;
  await whenSynced(view);
  if (view.state.doc !== text) return null;
  const at = await call(commands.navPytestFixtures(doc, offsetToPos(text, offset)));
  return view.state.doc === text ? at : null;
}

/** Text before the caret that may be inside a parameter list or a `usefixtures` / `getfixturevalue` string. */
const MAYBE_SLOT = /\bdef\s+\w+\s*\([^)]*$|\b(?:usefixtures|getfixturevalue)\s*\([^)]*["'][\w]*$/;

/** A fixture's file as the lookup shows it: below `site-packages/` for installed ones, else project-relative. */
export function where(path: string, root: string | null | undefined): string {
  const installed = path.lastIndexOf("/site-packages/");
  if (installed >= 0) return path.slice(installed + "/site-packages/".length);
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function completion(doc: EditorDocContext) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const view = ctx.view;
    if (!view || !isTauri()) return null;
    if (!MAYBE_SLOT.test(ctx.state.sliceDoc(Math.max(0, ctx.pos - 2000), ctx.pos))) return null;
    const word = ctx.matchBefore(/\w*/);
    // Typing a name, or right after `(`, `,` or a quote.
    if (!word || (word.from === word.to && !ctx.explicit && !/[(,"'\s]/.test(ctx.state.sliceDoc(ctx.pos - 1, ctx.pos))))
      return null;
    try {
      const at = await fixturesAt(view, doc.doc, ctx.pos);
      if (ctx.aborted || !at?.completions?.length) return null;
      const root = useProject.getState().project?.root;
      const n = at.completions.length;
      return {
        from: word.from,
        to: word.to,
        validFor: /^\w*$/,
        options: at.completions.map((item, i) => ({
          label: item.name,
          type: "variable",
          icon: "symbol-function",
          typeText: where(item.path, root),
          // Nearest first, as pytest picks them.
          boost: n - i,
        })),
      };
    } catch {
      return null;
    }
  };
}

export function activate(): () => void {
  const offNavigation = registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || doc.language !== "python" || !isTauri()) return null;
    const at = await fixturesAt(view, doc.doc, offset).catch(() => null);
    const ref = at?.reference;
    if (!ref?.definition) return null;
    const text = view.state.doc;
    return {
      from: posToOffset(text, ref.range.start),
      to: posToOffset(text, ref.range.end),
      targets: [{ ...ref.definition, name: ref.name }],
    };
  });
  const offCompletion = registerEditorContribution({
    id: "pytest-fixtures",
    extensions: (doc) =>
      doc.language === "python" && !doc.virtual && !doc.readOnly
        ? EditorState.languageData.of(() => [{ openideaCompletion: completion(doc) }])
        : [],
  });
  return () => {
    offNavigation();
    offCompletion();
  };
}
