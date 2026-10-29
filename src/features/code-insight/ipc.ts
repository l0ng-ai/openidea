/** IPC helpers shared by the code-insight views. */
import type { EditorView } from "@codemirror/view";
import { activeEditor, editorsFor } from "@/editor/api";
import { isVirtualUri, virtualDocument } from "@/platform/virtualDocs";
import { executeAction } from "@/platform/actions";
import { IpcError, call, commands, isCancelled, isTauri, unavailableText } from "@/platform/ipc";
import type { IdeError } from "@/bindings";
import { maybeEditorService, notifications } from "@/workbench/contributions";

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: IdeError };

export async function lspRequest<T>(run: () => Promise<Result<T>>): Promise<T> {
  if (!isTauri()) throw new IpcError({ kind: "unavailable", message: "No language server available" });
  try {
    return await call(run());
  } catch (e) {
    if (e instanceof IpcError) throw e;
    throw new IpcError({ kind: "internal", message: e instanceof Error ? e.message : String(e) });
  }
}

export const isUnavailable = (e: unknown) => e instanceof IpcError && e.kind === "unavailable";

/** Small hint at the caret (via editor/lsp), or a notification without an editor. */
export function hint(text: string, tone: "info" | "warning" | "error" = "info") {
  if (activeEditor()) void executeAction("editor.showHint", { text, tone });
  else
    notifications().notify({
      group: "lsp",
      level: tone === "error" ? "error" : "info",
      title: text,
      key: "code-insight.hint",
    });
}

export function reportError(e: unknown) {
  if (isCancelled(e)) return;
  hint(
    isUnavailable(e) ? unavailableText(e) : e instanceof Error ? e.message : String(e),
    isUnavailable(e) ? "info" : "error",
  );
}

export interface CaretContext {
  doc: number;
  path: string;
  line: number;
  col: number;
  /** Identifier at the caret, if any (for titles). */
  word: string | null;
  view: EditorView | null;
}

export function caretContext(): CaretContext | null {
  const cursor = maybeEditorService()?.activeCursor();
  const ed = activeEditor();
  if (cursor) {
    const view = ed && ed.ctx.doc === cursor.doc ? ed.view : null;
    return { ...cursor, word: view ? wordAt(view, cursor.offset) : null, view };
  }
  if (!ed) return null;
  const head = ed.view.state.selection.main.head;
  const line = ed.view.state.doc.lineAt(head);
  return {
    doc: ed.ctx.doc,
    path: ed.ctx.path,
    line: line.number - 1,
    col: head - line.from,
    word: wordAt(ed.view, head),
    view: ed.view,
  };
}

function wordAt(view: EditorView, offset: number): string | null {
  const w = view.state.wordAt(offset);
  return w ? view.state.sliceDoc(w.from, w.to) : null;
}

/** Screen point below the caret of the active editor. */
export function caretPoint(): { x: number; y: number } {
  const ed = activeEditor();
  if (ed) {
    const c = ed.view.coordsAtPos(ed.view.state.selection.main.head);
    if (c) return { x: c.left, y: c.bottom };
    const r = ed.view.dom.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 40 };
  }
  return { x: window.innerWidth / 2 - 200, y: window.innerHeight / 3 };
}

/** File lines from an open editor, else a read-only backend read. */
export async function readFileLines(path: string): Promise<string[] | null> {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.doc.toJSON();
  if (!isTauri()) return null;
  try {
    if (isVirtualUri(path)) return (await virtualDocument(path)).text.split(/\r\n?|\n/);
    const text = await call(commands.fsReadText(path));
    return text.split(/\r\n?|\n/);
  } catch {
    return null;
  }
}

/** File text for a preview pane (open buffer, else disk). */
export async function previewText(path: string): Promise<string> {
  const lines = await readFileLines(path);
  if (!lines) throw new Error("Cannot read the file");
  return lines.join("\n");
}

export async function readManyFileLines(
  paths: readonly string[],
  concurrency = 4,
): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  const queue = [...new Set(paths)];
  const worker = async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) out.set(p, await readFileLines(p));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * Runs `fn` with a backend document id for `path`, holding a reference only
 * for the duration of the call (ref-counted, so open editors are unaffected).
 */
export async function withDocument<T>(path: string, fn: (doc: number) => Promise<T>): Promise<T> {
  const open = editorsFor(path)[0];
  if (open) return fn(open.ctx.doc);
  const info = await lspRequest(() => commands.docOpen(path));
  try {
    return await fn(info.id);
  } finally {
    void commands.docClose(info.id);
  }
}

export function openLocation(path: string, line: number, col: number): Promise<void> {
  return maybeEditorService()?.openFile(path, { selection: { line, col }, focus: true }) ?? Promise.resolve();
}
