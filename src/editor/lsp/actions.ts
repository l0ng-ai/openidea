/** Actions of the LSP editor layer (ids from keymaps/intellij-macos.ts). */
import { generateActionIcon, isGenerateAction } from "./generate";
import type { EditorView } from "@codemirror/view";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { activeEditor, editorsFor, registerSaveParticipant, whenSynced, type TextEditorHandle } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { validateLanguages } from "@/platform/languageSettings";
import type { Settings } from "@/bindings";
import { explicitCompletion } from "./completion";
import { triggerSignatureHelp } from "./signature";
import { quickDefinition, quickDocumentation } from "./hover";
import { expressionTypeInfo } from "./typeInfo";
import { gotoHighlightedUsage, gotoTargets, highlightUsages } from "./navigation";
import { gotoDiagnostic, showErrorDescription } from "./diagnostics";
import { applyKindSilently, applyQuickFix, runKindAction, showIntentions } from "./intentions";
import { docOf } from "./lsp";
import { languageSemantics } from "./semantic";
import { workflowSettings, type ActionsOnSaveValid } from "@/platform/workflowSettings";
import { startRename } from "./rename";
import { formatDocument, reformatDialog, type FormatResult } from "./format";
import { showHint } from "./hint";
import {
  refactorThis,
  runRefactoring,
  safeDelete,
  showNothingHere,
  startHierarchyRefactoring,
} from "@/editor/refactor";
import { evaluateWhen } from "@/platform/context";
import { tx } from "@/platform/i18n";

/** Editor actions apply to the active text editor unless a tool window or popup owns the keyboard. */
export const EDITOR_WHEN = "textEditorActive && (editorFocus || !toolWindowFocus)";

/**
 * Languages whose servers offer Generate (constructors, accessors, overrides…).
 * Elsewhere the Generate shortcut (⌘N / Alt+Insert) yields to the New popup, as in IDEA.
 */
const GENERATE_LANGUAGES = [
  "java",
  "kotlin",
  "scala",
  "groovy",
  "rust",
  "go",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "c",
  "cpp",
  "objective-c",
  "objective-cpp",
  "csharp",
  "swift",
  "dart",
  "php",
];
export const GENERATE_KEY_WHEN = GENERATE_LANGUAGES.map((id) => `editorLangId == ${id}`).join(" || ");

function withEditor(run: (view: EditorView) => unknown): Action["run"] {
  return () => {
    const ed = activeEditor();
    if (!ed) return;
    void run(ed.view);
  };
}

/** The editor showing `path` once it is mounted (opening a file renders its editor a little later). */
async function mountedEditor(path: string, frames = 60): Promise<TextEditorHandle | null> {
  for (let i = 0; i < frames; i++) {
    const ed = editorsFor(path)[0];
    if (ed) return ed;
    await new Promise((r) => setTimeout(r, 16));
  }
  return null;
}

/** The editor of `path` (opened first), else the active editor. */
async function editorAt(path: unknown): Promise<TextEditorHandle | null> {
  let ed = activeEditor();
  if (typeof path === "string" && ed?.ctx.path !== path) {
    await maybeEditorService()?.openFile(path, { focus: true });
    ed = await mountedEditor(path);
  }
  return ed ?? null;
}

/** Runs on the file `{ path }` (opened in the editor first, as from the project view), else on the active editor. */
function inFile(run: (view: EditorView) => unknown): Action["run"] {
  return async ({ arg }) => {
    const ed = await editorAt(typeof arg === "string" ? arg : (arg as { path?: unknown } | undefined)?.path);
    if (ed) await run(ed.view);
  };
}

const reformat = (v: EditorView) => formatDocument(v, { explicit: true });
/** WebStorm's Fix ESLint Problems: vscode-eslint's fix-all for the whole file. */
const fixEslintProblems = (v: EditorView) =>
  runKindAction(v, "source.fixAll.eslint", {
    whole: true,
    none: "No ESLint problems to fix",
    label: "Fix ESLint Problems",
  });
/**
 * typescript-language-server's organize imports only sorts and merges them; removing the unused
 * ones is its own action, so Optimize Imports runs that first in these languages.
 */
const REMOVE_UNUSED_IMPORTS_FIRST = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact"]);

/** Removes unused imports where the server keeps that apart from organizing them; true when it did. */
export async function removeUnusedImports(view: EditorView): Promise<boolean> {
  const language = docOf(view)?.language;
  if (!language || !REMOVE_UNUSED_IMPORTS_FIRST.has(language)) return false;
  return applyKindSilently(view, "source.removeUnusedImports");
}

const optimizeImports = async (v: EditorView) => {
  if (await removeUnusedImports(v)) {
    // Then sort what is left; there may be nothing to sort.
    await applyKindSilently(v, "source.organizeImports");
    return;
  }
  return runKindAction(v, "source.organizeImports", {
    whole: true,
    none: "Optimize imports is not available",
    label: "Optimize Imports",
  });
};

export interface CleanupOptions {
  fixAll?: boolean;
  optimizeImports?: boolean;
  reformat?: boolean;
  /** Reformats only the lines changed since the last commit (IDEA's "Only VCS changed text"). */
  changedTextOnly?: boolean;
}

/** The lines changed since the last commit, as document ranges; none outside version control. */
async function vcsChangedRanges(view: EditorView): Promise<Array<{ from: number; to: number }>> {
  const path = docOf(view)?.path;
  if (!path) return [];
  // The hunks are computed against the backend's copy of the text.
  await whenSynced(view);
  let hunks;
  try {
    hunks = await call(commands.vcsLineHunks(path));
  } catch {
    return [];
  }
  const doc = view.state.doc;
  return hunks
    .filter((h) => h.lines > 0 && h.start < doc.lines)
    .map((h) => ({ from: doc.line(h.start + 1).from, to: doc.line(Math.min(h.start + h.lines, doc.lines)).to }));
}

/** Code Cleanup of one document: the server's fix-all, organize imports, then reformat (whose result it returns). */
async function cleanup(view: EditorView, o: CleanupOptions): Promise<FormatResult | null> {
  if (o.fixAll !== false) await applyKindSilently(view, "source.fixAll");
  if (o.optimizeImports !== false) {
    await removeUnusedImports(view);
    await applyKindSilently(view, "source.organizeImports");
  }
  if (o.reformat === false) return null;
  const ranges = o.changedTextOnly ? await vcsChangedRanges(view) : undefined;
  return formatDocument(view, { explicit: false, selectionOnly: false, ranges });
}

/**
 * Code Cleanup of the file at `path`, opened in the editor first: the batch step of
 * Code Cleanup and of Reformat Code on a directory. The reformat's result, or `null`
 * when the file has no text editor or reformatting was not asked for.
 */
export async function cleanupFile(path: string, o: CleanupOptions): Promise<FormatResult | null> {
  const ed = await editorAt(path);
  return ed && ed.ctx.path === path ? cleanup(ed.view, o) : null;
}

/** Code action titles of Implement Methods (⌃I) and Override Methods (⌃O). */
export const IMPLEMENT_TITLE =
  /\bimplement\b|\b(add|generate) (missing|unimplemented|all missing)\b|missing (members|methods|trait items)/i;
export const OVERRIDE_TITLE = /\boverride\b/i;

function editorAction(
  id: string,
  title: string,
  category: string,
  run: (view: EditorView) => unknown,
  extra: Partial<Action> = {},
): Action {
  return { id, title, category, when: EDITOR_WHEN, run: withEditor(run), ...extra };
}

/** Whether saving a `language` file formats it: Format on save, or Run on save of an external formatter. */
export function formatsOnSave(settings: Settings | null, language: string): boolean {
  const { prettier, oxfmt, ruff } = validateLanguages(settings?.languages);
  return (
    !!settings?.editor?.formatOnSave ||
    [prettier, oxfmt, ruff].some((formatter) => formatter.runOnSave && formatter.languages.includes(language))
  );
}

/** Format on save (settings.editor.formatOnSave), run by editor/core before writing. */
export function registerFormatOnSave(): () => void {
  return registerSaveParticipant({
    id: "lsp.formatOnSave",
    order: 50,
    beforeSave: async (ctx, handle) => {
      if (!handle || ctx.readOnly || !formatsOnSave(useProject.getState().settings, ctx.language)) return;
      await formatDocument(handle.view, { explicit: false, selectionOnly: false, onSave: true });
    },
  });
}

/** Settings › Tools › Actions on Save: optimize imports / code cleanup, before reformatting. */
export function registerActionsOnSave(): () => void {
  const participant = (id: string, order: number, kind: string, enabled: (s: ActionsOnSaveValid) => boolean) =>
    registerSaveParticipant({
      id,
      order,
      beforeSave: async (ctx, handle) => {
        if (!handle || ctx.readOnly || !enabled(workflowSettings().actionsOnSave)) return;
        await applyKindSilently(handle.view, kind);
      },
    });
  const disposers = [
    participant("lsp.organizeImportsOnSave", 40, "source.organizeImports", (s) => s.optimizeImports),
    participant("lsp.cleanupOnSave", 45, "source.fixAll", (s) => s.cleanup),
  ];
  return () => disposers.forEach((d) => d());
}

export function registerLspActions(): () => void {
  return registerActions([
    editorAction("code.completion", "Basic", "Code Completion", (v) => explicitCompletion(v), {
      icon: "list",
      keywords: ["code completion", "basic completion", "autocomplete"],
    }),
    editorAction("code.parameterInfo", "Parameter Info", "Code", (v) => triggerSignatureHelp(v, true)),
    editorAction("code.quickDocumentation", "Quick Documentation", "Code", quickDocumentation, {
      keywords: ["javadoc", "docs", "hover"],
    }),
    editorAction("code.quickDefinition", "Quick Definition", "Code", quickDefinition),
    editorAction(
      "code.quickTypeDefinition",
      "Quick Type Definition",
      "View",
      (v) => quickDefinition(v, "typeDefinition"),
      {
        keywords: ["type declaration", "preview"],
      },
    ),
    editorAction("code.showIntentions", "Show Context Actions", "Code", showIntentions, {
      keywords: ["intention", "quick fix", "lightbulb"],
    }),
    editorAction("code.applyQuickFix", "Apply Quick Fix", "Code", applyQuickFix, {
      keywords: ["fix error", "problem", "lightbulb"],
    }),
    editorAction("code.reformat", "Reformat Code", "Code", reformat, {
      keywords: ["format", "prettier"],
    }),
    editorAction(
      "code.reformatWithPrettier",
      "Reformat with Prettier",
      "Code",
      (v) => formatDocument(v, { explicit: true, tool: "prettier" }),
      { keywords: ["format", "prettier"] },
    ),
    editorAction(
      "code.reformatWithOxfmt",
      "Reformat with oxfmt",
      "Code",
      (v) => formatDocument(v, { explicit: true, tool: "oxfmt" }),
      { keywords: ["format", "oxfmt", "oxc"] },
    ),
    editorAction(
      "code.reformatWithRuff",
      "Reformat with Ruff",
      "Code",
      (v) => formatDocument(v, { explicit: true, tool: "ruff" }),
      { keywords: ["format", "ruff", "python"] },
    ),
    editorAction("code.reformatDialog", "Reformat File…", "Code", (v) =>
      reformatDialog(v, (view) => applyKindSilently(view, "source.organizeImports")),
    ),
    editorAction("code.fixEslintProblems", "Fix ESLint Problems", "Code", fixEslintProblems, {
      keywords: ["eslint", "lint", "fix all"],
    }),
    editorAction("code.optimizeImports", "Optimize Imports", "Code", optimizeImports, {
      keywords: ["organize imports"],
    }),
    // Project view / editor tab variants: `{ path }` of a file, opened first.
    {
      id: "code.reformatFile",
      title: "Reformat File",
      category: "Code",
      hidden: true,
      when: "projectOpen",
      run: inFile(reformat),
    },
    {
      id: "code.cleanupFile",
      title: "Code Cleanup in File",
      description:
        "Code Cleanup on `{ path, fixAll?, optimizeImports?, reformat? }` (all steps by default), opened first.",
      category: "Code",
      hidden: true,
      when: "projectOpen",
      run: (c) => {
        const o = (c.arg ?? {}) as CleanupOptions;
        return inFile((v) => cleanup(v, o))(c);
      },
    },
    {
      id: "code.optimizeImportsFile",
      title: "Optimize Imports in File",
      category: "Code",
      hidden: true,
      when: "projectOpen",
      run: inFile(optimizeImports),
    },
    editorAction(
      "navigate.declaration",
      "Go to Declaration or Usages",
      "Navigate",
      (v) => gotoTargets(v, "definition"),
      {
        keywords: ["definition"],
      },
    ),
    editorAction("navigate.implementation", "Go to Implementation(s)", "Navigate", (v) =>
      gotoTargets(v, "implementation"),
    ),
    editorAction("navigate.typeDeclaration", "Go to Type Declaration", "Navigate", (v) =>
      gotoTargets(v, "typeDefinition"),
    ),
    editorAction("navigate.nextError", "Next Highlighted Error", "Navigate", (v) => gotoDiagnostic(v, 1)),
    editorAction("navigate.prevError", "Previous Highlighted Error", "Navigate", (v) => gotoDiagnostic(v, -1)),
    editorAction("code.showErrorDescription", "Error Description", "View", showErrorDescription, {
      keywords: ["problem", "warning", "tooltip"],
    }),
    editorAction("find.highlightUsages", "Highlight Usages in File", "Find", highlightUsages),
    // Shares Next / Previous Occurrence's key on Windows (as in IDEA): that runs without highlighted usages.
    editorAction(
      "navigate.nextHighlightedUsage",
      "Next Highlighted Usage",
      "Navigate",
      (v) => gotoHighlightedUsage(v, 1) || executeAction("navigate.nextOccurrence"),
      { keyWhen: "editorTextFocus" },
    ),
    editorAction(
      "navigate.prevHighlightedUsage",
      "Previous Highlighted Usage",
      "Navigate",
      (v) => gotoHighlightedUsage(v, -1) || executeAction("navigate.prevOccurrence"),
      { keyWhen: "editorTextFocus" },
    ),
    {
      // Also outside an editor, where nothing applies: IDEA's "Nothing here" popup.
      id: "refactor.thisMenu",
      title: "Refactor This…",
      category: "Refactor",
      when: "projectOpen",
      run: ({ ctx }) => {
        const ed = activeEditor();
        if (ed && evaluateWhen(EDITOR_WHEN, ctx)) return refactorThis(ed.view, startRename);
        showNothingHere();
      },
    },
    editorAction("refactor.rename", "Rename…", "Refactor", startRename),
    editorAction("refactor.extractVariable", "Introduce Variable…", "Refactor", (v) =>
      runRefactoring(v, "extractVariable"),
    ),
    editorAction("refactor.extractMethod", "Extract Method…", "Refactor", (v) => runRefactoring(v, "extractMethod")),
    editorAction("refactor.extractConstant", "Introduce Constant…", "Refactor", (v) =>
      runRefactoring(v, "extractConstant"),
    ),
    editorAction("refactor.extractField", "Introduce Field…", "Refactor", (v) => runRefactoring(v, "extractField")),
    editorAction("refactor.extractParameter", "Introduce Parameter…", "Refactor", (v) =>
      runRefactoring(v, "extractParameter"),
    ),
    editorAction("refactor.extractInterface", "Extract Interface…", "Refactor", (v) =>
      runRefactoring(v, "extractInterface"),
    ),
    editorAction("refactor.move", "Move…", "Refactor", (v) => runRefactoring(v, "move")),
    editorAction("refactor.changeSignature", "Change Signature…", "Refactor", (v) =>
      runRefactoring(v, "changeSignature"),
    ),
    editorAction("refactor.safeDelete", "Safe Delete…", "Refactor", safeDelete),
    editorAction(
      "code.generate",
      "Generate…",
      "Code",
      (v) =>
        runKindAction(v, "", {
          predicate: isGenerateAction,
          none: "Nothing to generate here",
          label: tx("Generate"),
          compact: true,
          actionIcon: generateActionIcon,
        }),
      { keyWhen: GENERATE_KEY_WHEN },
    ),
    editorAction("refactor.inline", "Inline…", "Refactor", (v) => runRefactoring(v, "inline")),
    editorAction("refactor.pullMembersUp", "Pull Members Up…", "Refactor", (v) =>
      startHierarchyRefactoring(v, "pullUp"),
    ),
    editorAction("refactor.pushMembersDown", "Push Members Down…", "Refactor", (v) =>
      startHierarchyRefactoring(v, "pushDown"),
    ),
    // Implement / Override Methods: the server's code actions for them (jdtls "Override/Implement
    // Methods…", rust-analyzer "Implement missing members", TS "Implement interface"…).
    editorAction("code.implementMethods", "Implement Methods…", "Code", (v) =>
      runKindAction(v, "", {
        title: IMPLEMENT_TITLE,
        none: "Nothing to implement",
        label: "Implement Members",
        fallback: () => languageSemantics(docOf(v)?.language)?.implementMethods?.(v) ?? Promise.resolve(false),
      }),
    ),
    editorAction("code.overrideMethods", "Override Methods…", "Code", (v) =>
      runKindAction(v, "", { title: OVERRIDE_TITLE, none: "Nothing to override", label: "Override Members" }),
    ),
    editorAction("code.expressionTypeInfo", "Expression Type Info", "View", expressionTypeInfo, {
      keywords: ["type of expression", "show type"],
    }),
    {
      id: "editor.showHint",
      title: "Show Editor Hint",
      hidden: true,
      description: "Shows `{ text, tone? }` as a transient hint at the caret of the active editor.",
      run: ({ arg }) => {
        const view = activeEditor()?.view;
        const a = (arg ?? {}) as { text?: string; tone?: "info" | "warning" | "error"; data?: Record<string, string> };
        if (view && a.text) showHint(view, a.text, { tone: a.tone, data: a.data });
      },
    },
  ]);
}
