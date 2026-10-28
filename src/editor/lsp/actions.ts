/** Actions of the LSP editor layer (ids from keymaps/intellij-macos.ts). */
import type { EditorView } from "@codemirror/view";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { activeEditor, editorsFor, registerSaveParticipant, type TextEditorHandle } from "@/editor/api";
import { maybeEditorService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { explicitCompletion } from "./completion";
import { triggerSignatureHelp } from "./signature";
import { quickDefinition, quickDocumentation } from "./hover";
import { expressionTypeInfo } from "./typeInfo";
import { gotoHighlightedUsage, gotoTargets, highlightUsages } from "./navigation";
import { gotoDiagnostic, showErrorDescription } from "./diagnostics";
import { applyKindSilently, applyQuickFix, runKindAction, showIntentions } from "./intentions";
import { implementPythonAbstractMethods } from "./pythonMembers";
import { workflowSettings, type ActionsOnSaveValid } from "@/platform/workflowSettings";
import { startRename } from "./rename";
import { formatDocument, reformatDialog } from "./format";
import { showHint } from "./hint";
import { refactorThis, runRefactoring, safeDelete, showNothingHere } from "@/editor/refactor";
import { evaluateWhen } from "@/platform/context";

/** Editor actions apply to the active text editor unless a tool window or popup owns the keyboard. */
export const EDITOR_WHEN = "textEditorActive && (editorFocus || popupOpen || !toolWindowFocus)";

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

/** Runs on the file `{ path }` (opened in the editor first, as from the project view), else on the active editor. */
function inFile(run: (view: EditorView) => unknown): Action["run"] {
  return async ({ arg }) => {
    const path = typeof arg === "string" ? arg : (arg as { path?: unknown } | undefined)?.path;
    let ed = activeEditor();
    if (typeof path === "string" && ed?.ctx.path !== path) {
      await maybeEditorService()?.openFile(path, { focus: true });
      ed = await mountedEditor(path);
    }
    if (ed) await run(ed.view);
  };
}

const reformat = (v: EditorView) => formatDocument(v, { explicit: true });
const optimizeImports = (v: EditorView) =>
  runKindAction(v, "source.organizeImports", {
    whole: true,
    none: "Optimize imports is not available",
    label: "Optimize Imports",
  });

interface CleanupOptions {
  fixAll?: boolean;
  optimizeImports?: boolean;
  reformat?: boolean;
}

/** Code Cleanup of one document: the server's fix-all, organize imports, then reformat. */
async function cleanup(view: EditorView, o: CleanupOptions) {
  if (o.fixAll !== false) await applyKindSilently(view, "source.fixAll");
  if (o.optimizeImports !== false) await applyKindSilently(view, "source.organizeImports");
  if (o.reformat !== false) await formatDocument(view, { explicit: false });
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

/** Format on save (settings.editor.formatOnSave), run by editor/core before writing. */
export function registerFormatOnSave(): () => void {
  return registerSaveParticipant({
    id: "lsp.formatOnSave",
    order: 50,
    beforeSave: async (ctx, handle) => {
      if (!handle || ctx.readOnly || !useProject.getState().settings?.editor?.formatOnSave) return;
      await formatDocument(handle.view, { explicit: false, selectionOnly: false });
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
    editorAction("code.reformatDialog", "Reformat File…", "Code", (v) =>
      reformatDialog(v, (view) => applyKindSilently(view, "source.organizeImports")),
    ),
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
          title:
            /^(generate|implement|override|add (missing|derive|impl|getter|setter|constructor)|create (constructor|getter|setter))/i,
          none: "Nothing to generate here",
          label: "Generate",
        }),
      { keyWhen: GENERATE_KEY_WHEN },
    ),
    editorAction("refactor.inline", "Inline…", "Refactor", (v) => runRefactoring(v, "inline")),
    // Implement / Override Methods: the server's code actions for them (jdtls "Override/Implement
    // Methods…", rust-analyzer "Implement missing members", TS "Implement interface"…).
    editorAction("code.implementMethods", "Implement Methods…", "Code", (v) =>
      runKindAction(v, "", {
        title: IMPLEMENT_TITLE,
        none: "Nothing to implement",
        label: "Implement Members",
        fallback: () => implementPythonAbstractMethods(v),
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
        const a = (arg ?? {}) as { text?: string; tone?: "info" | "warning" | "error" };
        if (view && a.text) showHint(view, a.text, { tone: a.tone });
      },
    },
  ]);
}
