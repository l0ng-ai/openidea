/**
 * pytest fixtures: Go to Declaration on a fixture name (a test's or fixture's parameter, a
 * `usefixtures` / `getfixturevalue` string) opens the fixture pytest uses, completion offers
 * the visible fixtures there, and Find Usages / Rename on a fixture cover every place that
 * gets it. Resolution (conftest.py files, plugins, pytest's own fixtures) is the backend's
 * (`navPytestFixtures`, `navPytestFixtureTarget`, `navPytestFixtureUsages`,
 * `navPytestFixtureRename`); the language server knows none of it, except that a fixture
 * named by its function is a function it renames the Python references of.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  registerEditorContribution,
  registerNavigationProvider,
  registerRenameProvider,
  registerUsageProvider,
  whenSynced,
  type ContributedRename,
  type EditorDocContext,
} from "@/editor/api";
import { withDocument } from "@/editor/lsp/files";
import { docOf } from "@/editor/lsp/lsp";
import { offsetToPos, posToOffset } from "@/editor/lsp/positions";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isTauri,
  type FileEdit,
  type PytestFixtureAt,
  type RequestId,
  type TextEdit,
  type WorkspaceEdit,
} from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";

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

const NAME = /^[A-Za-z_]\w*$/;

const KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally for " +
    "from global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" "),
);

/** A name a fixture may be renamed to: an identifier, not a keyword. */
export const validFixtureName = (name: string) => NAME.test(name) && !KEYWORDS.has(name);

const sameRange = (a: TextEdit, b: TextEdit) =>
  a.range.start.line === b.range.start.line &&
  a.range.start.col === b.range.start.col &&
  a.range.end.line === b.range.end.line &&
  a.range.end.col === b.range.end.col;

/**
 * `own` with the text edits of `other` added, one file edit per path: the fixture rename and
 * the language server's rename of the same function both rename the definition, once.
 */
export function mergeEdits(own: WorkspaceEdit, other: WorkspaceEdit): WorkspaceEdit {
  const files: FileEdit[] = own.files.map((f) => (f.kind === "edit" ? { ...f, edits: [...f.edits] } : f));
  for (const f of other.files) {
    if (f.kind !== "edit") continue;
    const mine = files.find((m): m is Extract<FileEdit, { kind: "edit" }> => m.kind === "edit" && m.path === f.path);
    if (!mine) files.push(f);
    else for (const e of f.edits) if (!mine.edits.some((m) => sameRange(m, e))) mine.edits.push(e);
  }
  return { files, preconditions: [...(own.preconditions ?? []), ...(other.preconditions ?? [])] };
}

/** Rename of the fixture at `offset`: from its definition, a place that gets it, or a read of such a parameter. */
async function fixtureRename(view: EditorView, offset: number): Promise<ContributedRename | null> {
  const doc = docOf(view);
  if (!doc || doc.virtual || doc.language !== "python" || !isTauri()) return null;
  const text = view.state.doc;
  await whenSynced(view);
  if (view.state.doc !== text) return null;
  const pos = offsetToPos(text, offset);
  const target = await call(commands.navPytestFixtureTarget(doc.doc, pos));
  if (!target || view.state.doc !== text) return null;
  const span = { from: posToOffset(text, target.range.start), to: posToOffset(text, target.range.end) };
  const edit = async (newName: string, request: RequestId) => {
    if (!validFixtureName(newName)) throw new Error(tx`'${newName}' is not a valid fixture name`);
    const renamed = await call(commands.navPytestFixtureRename(doc.doc, pos, newName, request));
    if (renamed.clash) {
      const file = basename(renamed.clash.path);
      const line = renamed.clash.range.start.line + 1;
      throw new Error(tx`'${newName}' is already used in ${file}:${line}`);
    }
    if (!target.functionName) return { edit: renamed.edit };
    // Python code may import or call the fixture's function: the server renames those.
    const at = target.definition;
    try {
      const server = await withDocument(at.path, (d) => call(commands.lspRename(request, d, at.range.start, newName)));
      return { edit: mergeEdits(renamed.edit, server.edit) };
    } catch {
      const name = target.name;
      return {
        edit: renamed.edit,
        note: tx`Python references to the function '${name}' were not renamed: no language server answered`,
      };
    }
  };
  return target.inProject
    ? { ...span, edit }
    : { ...span, edit, refused: tx("The fixture is defined outside the project") };
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
  const offUsages = registerUsageProvider(async (query, request) => {
    if (!query.path.endsWith(".py") || !isTauri()) return null;
    const found = await call(commands.navPytestFixtureUsages(query.doc, query.pos, request));
    return found?.usages ?? null;
  });
  const offRename = registerRenameProvider(fixtureRename);
  return () => {
    offNavigation();
    offCompletion();
    offUsages();
    offRename();
  };
}
