import { Transaction, type Text } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { CodeAction, Diagnostic, FileEdit, TextEdit, WorkspaceEdit } from "@/bindings";
import { ipcPath } from "@/platform/paths";
import { commands, IpcError, nextRequestId } from "@/platform/ipc";
import { editorPrefs } from "@/platform/editorSettings";
import { registerAction } from "@/platform/actions";
import { isExternalChange, transientChange, whenSynced } from "@/editor/api";
import { subscribeDiagnostics, type DiagnosticPublication } from "./diagnostics";
import { docOf, lspRequest } from "./lsp";
import { comparePos, rangeToOffsets } from "./positions";
import { closePopup, openPopup, useLspPopup, type LspPopup } from "./popupStore";
import { actionsForDiagnostic } from "./intentions";

const WAIT_MS = 8000;
const SETTLE_MS = 200;
const IMPORT_FIX = /^(?:(?:add|insert|update) (?:an? )?import\b|import\b|add .+ to (?:an? )?existing import\b)/i;
const UNRESOLVED =
  /cannot find (?:name|namespace|type|value|function|macro|trait|module)|cannot be resolved|failed to resolve|unresolved (?:reference|name|type|symbol|import)|use of undeclared|undeclared (?:name|identifier)|undefined(?::| (?:name|variable))|not defined|unknown (?:identifier|symbol|type|name)|does not exist in (?:the )?current context|type or namespace name .+ could not be found/i;
const UNRESOLVED_CODE =
  /^(?:2304|2552|2503|reportUndefinedVariable|UNRESOLVED_REFERENCE|undeclared_var_use|E0405|E0412|E0422|E0425|E0432|E0433|CS0103|CS0246)$/;

interface PastedRange {
  from: number;
  to: number;
}

export function pastedDiagnostics(
  doc: Text,
  ranges: readonly PastedRange[],
  items: readonly Diagnostic[],
): Diagnostic[] {
  return items.filter((d) => {
    if (d.unnecessary || d.deprecated || (!UNRESOLVED.test(d.message) && !UNRESOLVED_CODE.test(d.code ?? "")))
      return false;
    if (comparePos(d.range.start, d.range.end) >= 0) return false;
    for (const pos of [d.range.start, d.range.end]) {
      if (pos.line < 0 || pos.line >= doc.lines || pos.col < 0 || pos.col > doc.line(pos.line + 1).length) return false;
    }
    const { from, to } = rangeToOffsets(doc, d.range);
    return ranges.some((r) => r.from <= from && to <= r.to);
  });
}

export function pastedImport(actions: readonly CodeAction[]): CodeAction | null {
  const imports = actions.filter(
    (a) =>
      a.disabledReason == null &&
      (!a.kind || a.kind === "quickfix" || a.kind.startsWith("quickfix.")) &&
      IMPORT_FIX.test(a.title) &&
      !/^import (?:all|missing)\b/i.test(a.title),
  );
  return imports.length === 1 ? imports[0]! : null;
}

interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

function lspEditsOf(arg: unknown): [string, number | null, LspTextEdit[]][] | null {
  if (!arg || typeof arg !== "object") return [];
  const edit = arg as {
    changes?: Record<string, LspTextEdit[]>;
    documentChanges?: { textDocument?: { uri: string; version?: number | null }; edits?: LspTextEdit[] }[];
  };
  if (edit.documentChanges) {
    const out: [string, number | null, LspTextEdit[]][] = [];
    for (const change of edit.documentChanges) {
      if (!change.textDocument || !change.edits) return null;
      out.push([change.textDocument.uri, change.textDocument.version ?? null, change.edits]);
    }
    return out;
  }
  return edit.changes ? Object.entries(edit.changes).map(([uri, edits]) => [uri, null, edits]) : [];
}

function uriPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  const path = decodeURIComponent(new URL(uri).pathname);
  return ipcPath(/^\/[A-Za-z]:/.test(path) ? path.slice(1) : path);
}

/**
 * Some servers (typescript-language-server) send an import fix as a command
 * carrying an LSP WorkspaceEdit instead of an `edit`; lift it into one when it
 * only edits `path`, so it merges and applies like any other fix.
 */
export function withCommandEdit(action: CodeAction, path: string): CodeAction {
  if (action.edit || !action.command) return action;
  const files: FileEdit[] = [];
  for (const raw of action.command.arguments as unknown[]) {
    let arg = raw;
    if (typeof raw === "string") {
      try {
        arg = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const docs = lspEditsOf(arg);
    if (!docs) return action;
    for (const [uri, version, edits] of docs) {
      if (uriPath(uri) !== ipcPath(path)) return action;
      files.push({
        kind: "edit",
        path,
        version,
        edits: edits.map((e) => ({
          range: {
            start: { line: e.range.start.line, col: e.range.start.character },
            end: { line: e.range.end.line, col: e.range.end.character },
          },
          new_text: e.newText,
        })),
      });
    }
  }
  return files.length ? { ...action, edit: { files } } : action;
}

/** Merge edits computed against one snapshot, keeping their content/version guards. */
export function mergePastedImports(path: string, actions: readonly CodeAction[]): WorkspaceEdit | null {
  const edits: TextEdit[] = [];
  const preconditions = new Map<string, string>();
  let version: number | null | undefined;
  for (const action of actions) {
    if (!action.edit?.files.length) return null;
    for (const p of action.edit.preconditions ?? []) {
      if (preconditions.has(p.path) && preconditions.get(p.path) !== p.hash) return null;
      preconditions.set(p.path, p.hash);
    }
    for (const file of action.edit.files) {
      if (file.kind !== "edit" || file.path !== path || !file.edits.length) return null;
      if (version != null && file.version != null && version !== file.version) return null;
      version ??= file.version;
      for (const edit of file.edits) {
        if (!edit.new_text.trim() || comparePos(edit.range.start, edit.range.end) > 0) return null;
        if (!edits.some((e) => JSON.stringify(e) === JSON.stringify(edit))) edits.push(edit);
      }
    }
  }
  edits.sort((a, b) => comparePos(a.range.start, b.range.start) || comparePos(a.range.end, b.range.end));
  const merged: TextEdit[] = [];
  for (const edit of edits) {
    const previous = merged.at(-1);
    if (previous) {
      const sameStart = comparePos(previous.range.start, edit.range.start) === 0;
      const bothInsert =
        comparePos(previous.range.start, previous.range.end) === 0 &&
        comparePos(edit.range.start, edit.range.end) === 0;
      if (sameStart && bothInsert) {
        // Only whole import lines can be concatenated at a shared insertion point.
        if (!previous.new_text.endsWith("\n") || !edit.new_text.endsWith("\n")) return null;
        previous.new_text += edit.new_text;
        continue;
      }
      if (sameStart || comparePos(edit.range.start, previous.range.end) < 0) return null;
    }
    merged.push({ ...edit });
  }
  return merged.length
    ? {
        files: [{ kind: "edit", path, edits: merged, version }],
        preconditions: [...preconditions].map(([path, hash]) => ({ path, hash })),
      }
    : null;
}

interface PendingPaste {
  context: NonNullable<ReturnType<typeof docOf>>;
  doc: Text;
  ranges: PastedRange[];
  diagnostics: Map<string, Diagnostic[]>;
  abort: AbortController;
  deadline: ReturnType<typeof setTimeout>;
  settle?: ReturnType<typeof setTimeout>;
  running: boolean;
  synced: boolean;
  popup?: Extract<LspPopup, { kind: "importsOnPaste" }>;
}

function cancelled(): IpcError {
  return new IpcError({ kind: "cancelled", message: "cancelled" });
}

/** Resolution has no request id; abandon its result immediately on cancellation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const importsOnPastePlugin = ViewPlugin.fromClass(
  class {
    private pending?: PendingPaste;
    private unsubscribe: () => void;

    constructor(private view: EditorView) {
      const doc = docOf(view);
      this.unsubscribe = doc ? subscribeDiagnostics(doc.path, (e) => this.published(e)) : () => {};
    }

    update(update: ViewUpdate) {
      if (
        this.pending &&
        (!this.current(this.pending) || (update.focusChanged && !this.view.hasFocus && !this.pending.popup))
      )
        this.cancel();
      if (!update.docChanged) return;
      this.cancel();
      const doc = docOf(this.view);
      if (!doc || doc.readOnly || this.view.state.readOnly || editorPrefs().autoImport.importsOnPaste === "never")
        return;
      let ranges: PastedRange[] = [];
      for (const tr of update.transactions) {
        ranges = ranges.map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }));
        if (
          tr.annotation(Transaction.userEvent) !== "input.paste" ||
          isExternalChange(tr) ||
          tr.annotation(transientChange)
        )
          continue;
        tr.changes.iterChanges((_a, _b, from, to) => {
          if (from < to) ranges.push({ from, to });
        });
      }
      if (!ranges.length) return;
      const pending: PendingPaste = {
        context: doc,
        doc: this.view.state.doc,
        ranges,
        diagnostics: new Map(),
        abort: new AbortController(),
        deadline: setTimeout(() => this.cancel(), WAIT_MS),
        running: false,
        synced: false,
      };
      this.pending = pending;
      // Let the editor's update listener enqueue the paste before flushing it.
      void Promise.resolve()
        .then(() => whenSynced(this.view))
        .then(() => {
          if (this.current(pending)) pending.synced = true;
        })
        .catch(() => {
          if (this.pending === pending) this.cancel();
        });
    }

    private current(p: PendingPaste) {
      return (
        this.pending === p &&
        !p.abort.signal.aborted &&
        this.view.dom.isConnected &&
        this.view.state.doc === p.doc &&
        docOf(this.view) === p.context &&
        !this.view.state.readOnly &&
        !docOf(this.view)?.readOnly &&
        editorPrefs().autoImport.importsOnPaste !== "never"
      );
    }

    private published(e?: DiagnosticPublication) {
      const p = this.pending;
      if (!p || !e || !p.synced || !this.current(p) || p.running) return;
      p.diagnostics.set(e.source, e.items);
      clearTimeout(p.settle);
      p.settle = setTimeout(() => void this.collect(p), SETTLE_MS);
    }

    private async collect(p: PendingPaste) {
      if (!this.current(p)) return this.cancel();
      const doc = docOf(this.view)!;
      const diagnostics = pastedDiagnostics(p.doc, p.ranges, [...p.diagnostics.values()].flat());
      if (!diagnostics.length) return;
      p.running = true;
      const imports: CodeAction[] = [];
      const seen = new Set<string>();
      try {
        for (const d of diagnostics) {
          const key = JSON.stringify([d.range, d.message, d.code, d.source]);
          if (seen.has(key)) continue;
          seen.add(key);
          const id = nextRequestId();
          const cancel = () => void commands.cancelRequest(id).catch(() => {});
          p.abort.signal.addEventListener("abort", cancel, { once: true });
          let actions: CodeAction[];
          try {
            const result = await abortable(
              lspRequest(
                () => commands.lspCodeActionQuery(id, doc.doc, d.range, ["quickfix"]),
                () => this.current(p),
              ),
              p.abort.signal,
            );
            actions = result.actions;
          } finally {
            p.abort.signal.removeEventListener("abort", cancel);
          }
          if (!this.current(p)) return;
          let fix = pastedImport(actionsForDiagnostic(actions, d));
          if (!fix) continue;
          fix = withCommandEdit(fix, doc.path);
          if (!fix.edit)
            fix = await abortable(
              lspRequest(
                () => commands.lspResolveCodeAction(doc.doc, fix!),
                () => this.current(p),
              ),
              p.abort.signal,
            );
          if (!this.current(p)) return;
          fix = withCommandEdit(fix, doc.path);
          if (!pastedImport([fix]) || !mergePastedImports(doc.path, [fix])) continue;
          if (imports.some((a) => JSON.stringify(a.edit) === JSON.stringify(fix.edit))) continue;
          if (mergePastedImports(doc.path, [...imports, fix])) imports.push(fix);
        }
        if (!this.current(p) || !imports.length) return;
        clearTimeout(p.deadline);
        if (editorPrefs().autoImport.importsOnPaste === "always") await this.apply(p, imports);
        else if (!useLspPopup.getState().popup) {
          p.popup = {
            kind: "importsOnPaste",
            imports: imports.map((a) => a.title),
            onApply: (selected) =>
              void this.apply(
                p,
                imports.filter((_a, i) => selected.includes(i)),
              ),
            onClose: () => {
              if (this.pending === p) this.cancel();
            },
          };
          openPopup(p.popup);
        }
      } catch {
        // Missing/slow servers leave the paste and normal quick fixes alone.
      } finally {
        if (!p.popup && this.pending === p) this.cancel();
      }
    }

    private async apply(p: PendingPaste, imports: CodeAction[]) {
      if (!this.current(p)) return this.cancel();
      const edit = mergePastedImports(docOf(this.view)!.path, imports);
      this.cancel();
      if (!edit) return;
      try {
        await lspRequest(
          () => commands.applyWorkspaceEdit(edit),
          () =>
            this.view.dom.isConnected &&
            this.view.state.doc === p.doc &&
            docOf(this.view) === p.context &&
            !this.view.state.readOnly &&
            !p.context.readOnly &&
            editorPrefs().autoImport.importsOnPaste !== "never",
        );
      } catch {
        // Workspace edit preconditions reject an edit if the document changed.
      }
    }

    private cancel() {
      const p = this.pending;
      this.pending = undefined;
      if (!p) return;
      clearTimeout(p.deadline);
      clearTimeout(p.settle);
      p.abort.abort();
      if (p.popup && useLspPopup.getState().popup === p.popup) closePopup();
    }

    destroy() {
      this.cancel();
      this.unsubscribe();
    }
  },
);

export function importsOnPasteExtension() {
  return importsOnPastePlugin;
}

export function registerImportsOnPasteActions(): () => void {
  return registerAction({
    id: "code.applyPastedImports",
    title: "Add Imports",
    category: "Code",
    hidden: true,
    run: ({ arg }) => {
      const popup = useLspPopup.getState().popup;
      if (popup?.kind === "importsOnPaste" && Array.isArray(arg))
        popup.onApply(arg.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < popup.imports.length));
    },
  });
}
