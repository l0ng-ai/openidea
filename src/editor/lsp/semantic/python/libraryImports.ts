/**
 * PyCharm's "Import this name" for names from installed packages. basedpyright offers import
 * fixes for the project's own symbols and the standard library only; the backend's index of
 * the interpreter's site-packages supplies the rest, and a server import fix replaces them.
 */
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import type { ContributedIntention } from "@/editor/api";
import type { PythonImportCandidate } from "@/bindings";
import { call, commands, isTauri, nextRequestId, type CodeAction } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { docOf } from "../../lsp";
import type { EditorDiagnostic } from "../../diagnostics";
import { UNDEFINED_NAME } from "./createFromUsage";
import { importChanges } from "./imports";

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const IMPORT_TITLE = /\bimport\b/i;

/** The unresolved name a diagnostic reports at `pos`. */
export function undefinedNameAt(state: EditorState, pos: number): string | null {
  let name: string | null = null;
  forEachDiagnostic(state, (d, from, to) => {
    const code = (d as EditorDiagnostic).problem?.code;
    if (name || code == null || !UNDEFINED_NAME.has(code) || pos < from || pos > to) return;
    const text = state.doc.sliceString(from, to);
    if (IDENTIFIER.test(text)) name = text;
  });
  return name;
}

/** The statement a candidate adds. */
export function importStatement(c: PythonImportCandidate): string {
  return c.name ? `from ${c.module} import ${c.name}` : `import ${c.module}`;
}

/** A quick fix of the server that imports `name` (basedpyright's for project and standard library names). */
function importsName(name: string) {
  return (a: CodeAction) =>
    (!a.kind || a.kind.startsWith("quickfix")) && IMPORT_TITLE.test(a.title) && a.title.includes(name);
}

/** ⌥↵ rows that import the unresolved name at the caret from an installed package. */
export async function pythonLibraryImports(view: EditorView, signal: AbortSignal): Promise<ContributedIntention[]> {
  const doc = docOf(view);
  const selection = view.state.selection.main;
  if (doc?.uiMode !== "Python" || doc.readOnly || !selection.empty || !isTauri()) return [];
  const name = undefinedNameAt(view.state, selection.head);
  if (!name) return [];
  // The first request waits for the index of the interpreter's packages; moving on cancels it.
  const request = nextRequestId();
  const cancel = () => void commands.cancelRequest(request);
  signal.addEventListener("abort", cancel, { once: true });
  let candidates: PythonImportCandidate[];
  try {
    candidates = await call(commands.navPythonLibraryImports(doc.doc, name, request));
  } catch {
    return [];
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (signal.aborted) return [];
  return candidates.map((c, i) => ({
    id: `python.import:${importStatement(c)}`,
    label: c.name ? tx`Import '${c.name}' from '${c.module}'` : tx`Import module '${c.module}'`,
    quickFix: true,
    // As in PyCharm, importing an unresolved name comes before creating it.
    emphasis: i === 0,
    supersededBy: importsName(name),
    run: () => {
      view.dispatch({ changes: importChanges(view.state.doc, [importStatement(c)]), userEvent: "input.complete" });
      view.focus();
    },
  }));
}
