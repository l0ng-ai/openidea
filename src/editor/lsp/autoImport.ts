/**
 * Settings › Editor › General › Auto Import, on top of LSP code actions:
 *  - "Add unambiguous imports on the fly": an unresolved reference whose quick
 *    fixes contain exactly one import action gets it applied;
 *  - "Optimize imports on the fly": `source.organizeImports` runs once the file
 *    has no errors, unless its edit touches the caret line.
 * Both wait until typing pauses and never act on the caret line.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { commands, type CodeAction, type Diagnostic } from "@/platform/ipc";
import { editorPrefs } from "@/platform/editorSettings";
import { docOf, isUnavailable, lspRequest } from "./lsp";
import { diagnosticsFor, subscribeDiagnostics } from "./diagnostics";
import { applyCodeAction } from "./intentions";
import { offsetsToRange, rangeToOffsets } from "./positions";
import { featureBackoff } from "./availability";

const IDLE_MS = 1500;
const IMPORT_TITLE = /\bimport\b/i;
const importBackoff = featureBackoff();

/** The single import fix among `actions`, if exactly one exists. */
export function unambiguousImport(actions: readonly CodeAction[]): CodeAction | null {
  const imports = actions.filter(
    (a) => !a.disabledReason && IMPORT_TITLE.test(a.title) && (!a.kind || a.kind.startsWith("quickfix")),
  );
  return imports.length === 1 ? imports[0]! : null;
}

/** Whether a workspace edit for `path` touches 0-based `line`. */
export function editTouchesLine(action: CodeAction, path: string, line: number): boolean {
  for (const f of action.edit?.files ?? []) {
    if (f.kind !== "edit" || f.path !== path) continue;
    if (f.edits.some((e) => e.range.start.line <= line && line <= e.range.end.line)) return true;
  }
  return false;
}

const autoImportPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private unsubscribe: (() => void) | undefined;
    private tried = new Set<string>();
    private dirty = false;
    private running = false;

    constructor(private view: EditorView) {
      const doc = docOf(view);
      if (doc) this.unsubscribe = subscribeDiagnostics(doc.path, () => this.schedule());
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.dirty = true;
        this.schedule();
      }
    }

    private schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.run(), IDLE_MS);
    }

    private async run() {
      const prefs = editorPrefs().autoImport;
      const view = this.view;
      const doc = docOf(view);
      if ((!prefs.addUnambiguous && !prefs.optimizeOnTheFly) || this.running || !doc || doc.readOnly) return;
      if (!view.dom.isConnected || !view.hasFocus || importBackoff.active(doc.doc)) return;
      this.running = true;
      try {
        const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
        const errors = diagnosticsFor(doc.path).filter((d) => d.severity === "error");
        if (prefs.addUnambiguous) await this.addImports(errors, caretLine);
        if (prefs.optimizeOnTheFly && this.dirty && !diagnosticsFor(doc.path).some((d) => d.severity === "error")) {
          this.dirty = false;
          await this.optimize(caretLine);
        }
      } catch (e) {
        // Servers without these code actions: nothing to do.
        if (isUnavailable(e)) importBackoff.mark(doc.doc);
      } finally {
        this.running = false;
      }
    }

    private async addImports(errors: Diagnostic[], caretLine: number) {
      const doc = docOf(this.view)!;
      for (const d of errors.slice(0, 8)) {
        if (d.range.start.line <= caretLine && caretLine <= d.range.end.line) continue;
        const key = `${d.range.start.line}:${d.range.start.col}:${d.message}`;
        if (this.tried.has(key)) continue;
        this.tried.add(key);
        const actions = await lspRequest(() => commands.lspCodeActions(doc.doc, d.range, ["quickfix"]));
        const fix = unambiguousImport(actions);
        if (fix && !editTouchesLine(fix, doc.path, caretLine)) {
          await applyCodeAction(this.view, fix);
          return;
        }
      }
      if (this.tried.size > 500) this.tried.clear();
    }

    private async optimize(caretLine: number) {
      const view = this.view;
      const doc = docOf(view)!;
      const range = offsetsToRange(view.state.doc, 0, view.state.doc.length);
      const actions = await lspRequest(() => commands.lspCodeActions(doc.doc, range, ["source.organizeImports"]));
      const action = actions.find((a) => a.kind?.startsWith("source.organizeImports") && !a.disabledReason && a.edit);
      if (!action || editTouchesLine(action, doc.path, caretLine)) return;
      const edits = action.edit!.files.flatMap((f) => (f.kind === "edit" && f.path === doc.path ? f.edits : []));
      const noop = edits.every((e) => {
        const { from, to } = rangeToOffsets(view.state.doc, e.range);
        return view.state.sliceDoc(from, to) === e.new_text;
      });
      if (!noop) await applyCodeAction(view, action);
    }

    destroy() {
      clearTimeout(this.timer);
      this.unsubscribe?.();
    }
  },
);

export function autoImportExtension() {
  return autoImportPlugin;
}
