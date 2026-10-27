/**
 * Move / rename of files and folders as a refactoring (IDEA's Move / Rename on
 * files): the language servers' reference updates (`workspace/willRenameFiles`),
 * optionally textual occurrences in comments and strings, a preview when other
 * files change, then the move itself — one step that Undo reverts.
 */
import type { FileMove, UndoOutcome, WorkspaceEdit } from "@/bindings";
import { openEditorPaths } from "@/editor/api";
import { call, commands, emitLocalIdeEvent, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { projectFs } from "./fs";
import { isSameOrInside, nameOf, parentOf } from "./paths";
import { previewFileRefactoring } from "./RefactoringPreview";
import { useProjectTree } from "./store";

export interface FileRefactorOptions {
  /** Update references through the language servers. */
  references: boolean;
  /** Also replace the old name / path in comments, strings and text files. */
  textOccurrences: boolean;
}

export interface CollectedEdits {
  edit: WorkspaceEdit;
  /** Language servers that could not answer. */
  errors: string[];
}

/** What the refactoring talks to: the backend in the app, the project fs elsewhere (tests, browser). */
export interface FileRefactorBackend {
  edits(moves: FileMove[], options: FileRefactorOptions, signal?: AbortSignal): Promise<CollectedEdits>;
  move(moves: FileMove[], edit: WorkspaceEdit, label: string): Promise<number>;
  undo(id: number): Promise<UndoOutcome>;
}

const empty: WorkspaceEdit = { files: [] };

/** A cancellable backend request: `signal` cancels it via `cancel_request`. */
async function cancellable<T>(signal: AbortSignal | undefined, run: (request: number) => Promise<T>): Promise<T> {
  const request = nextRequestId();
  const onAbort = () => void commands.cancelRequest(request);
  signal?.addEventListener("abort", onAbort);
  try {
    return await run(request);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export const tauriRefactorBackend: FileRefactorBackend = {
  async edits(moves, options, signal) {
    const errors: string[] = [];
    const [lsp, text] = await Promise.all([
      options.references
        ? cancellable(signal, (r) => call(commands.refactorFileMoveEdits(r, moves)))
        : Promise.resolve({ edit: empty, servers: [], errors: [] }),
      options.textOccurrences
        ? cancellable(signal, (r) => call(commands.refactorFileMoveTextEdits(r, moves)))
        : Promise.resolve(empty),
    ]);
    errors.push(...lsp.errors);
    return { edit: mergeEdits(lsp.edit, text), errors };
  },
  move: (moves, edit, label) => call(commands.refactorMoveFiles(moves, edit, label)),
  undo: (id) => call(commands.refactorUndoFileMove(id)),
};

/** Plain-browser / test backend: no reference updates, moves through the project fs. */
export function memoryRefactorBackend(): FileRefactorBackend {
  const records = new Map<number, FileMove[]>();
  let next = 0;
  const fs = () => projectFs(useProjectTree.getState().root ?? "/");
  return {
    edits: async () => ({ edit: empty, errors: [] }),
    async move(moves) {
      const done: FileMove[] = [];
      try {
        for (const m of moves) {
          await fs().rename(m.from, m.to);
          done.push(m);
        }
      } catch (e) {
        for (const m of done.reverse()) await fs().rename(m.to, m.from).catch(() => {});
        throw e;
      }
      records.set(++next, moves);
      return next;
    },
    async undo(id) {
      const moves = records.get(id);
      if (!moves) throw new Error("The refactoring can no longer be undone");
      records.delete(id);
      const back = [...moves].reverse().map((m) => ({ from: m.to, to: m.from }));
      for (const m of back) await fs().rename(m.from, m.to);
      return { moves: back, conflicts: [] };
    },
  };
}

let backendOverride: FileRefactorBackend | null = null;
let memoryBackend: FileRefactorBackend | null = null;

export function refactorBackend(): FileRefactorBackend {
  if (backendOverride) return backendOverride;
  if (isTauri()) return tauriRefactorBackend;
  return (memoryBackend ??= memoryRefactorBackend());
}

/** Tests: replace the backend (null restores the default). */
export function setRefactorBackendForTests(b: FileRefactorBackend | null) {
  backendOverride = b;
  memoryBackend = null;
}

// ---------------------------------------------------------------------------
// Edits

function overlaps(a: { start: { line: number; col: number }; end: { line: number; col: number } }, b: typeof a) {
  const before = (p: typeof a.start, q: typeof a.start) => p.line < q.line || (p.line === q.line && p.col <= q.col);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/**
 * Server edits plus textual occurrences that no server edit already covers.
 * Only text edits are kept: the move itself is the refactoring's file operation.
 */
export function mergeEdits(lsp: WorkspaceEdit, text: WorkspaceEdit): WorkspaceEdit {
  const byPath = new Map<string, Extract<WorkspaceEdit["files"][number], { kind: "edit" }>["edits"]>();
  for (const f of lsp.files) {
    if (f.kind !== "edit") continue;
    byPath.set(f.path, [...(byPath.get(f.path) ?? []), ...f.edits]);
  }
  for (const f of text.files) {
    if (f.kind !== "edit") continue;
    const existing = byPath.get(f.path) ?? [];
    const extra = f.edits.filter((t) => !existing.some((e) => overlaps(e.range, t.range)));
    if (extra.length) byPath.set(f.path, [...existing, ...extra]);
  }
  return { files: [...byPath].filter(([, e]) => e.length).map(([path, edits]) => ({ kind: "edit", path, edits })) };
}

/** Whether `edit` changes files other than the moved ones (IDEA previews those refactorings). */
export function touchesOtherFiles(edit: WorkspaceEdit, moves: readonly FileMove[]): boolean {
  return edit.files.some((f) => f.kind === "edit" && f.edits.length && !moves.some((m) => isSameOrInside(f.path, m.from)));
}

// ---------------------------------------------------------------------------
// Editors follow the move

async function saveAllQuietly(editor: { saveAll(): Promise<void> }) {
  try {
    await editor.saveAll();
  } catch {
    /* unsaved files are reported by the editor */
  }
}

/** `path` after `moves`. */
export function movedPath(path: string, moves: readonly FileMove[]): string {
  let p = path;
  for (const m of moves) if (isSameOrInside(p, m.from)) p = m.to + p.slice(m.from.length);
  return p;
}

/** IDEA retargets editors of moved files: unsaved changes are saved first, tabs reopen at the new paths. */
async function withEditorsFollowing<T>(run: () => Promise<T>, done: (r: T) => FileMove[]): Promise<T> {
  const editor = maybeEditorService();
  const openBefore = editor ? openEditorPaths() : [];
  if (editor) await saveAllQuietly(editor);
  const active = editor?.activePath() ?? null;
  const result = await run();
  const applied = done(result);
  const open = openBefore.filter((p) => applied.some((m) => isSameOrInside(p, m.from)));
  if (applied.length)
    emitLocalIdeEvent({
      type: "fsChanged",
      created: applied.map((m) => m.to),
      modified: [],
      removed: applied.map((m) => m.from),
    });
  if (!editor || !open.length) return result;
  const ordered = active && open.includes(active) ? [...open.filter((p) => p !== active), active] : open;
  for (const p of ordered) await editor.openFile(movedPath(p, applied), { focus: false }).catch(() => {});
  if (active && !open.includes(active)) await editor.openFile(active, { focus: false }).catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Run / undo

let lastMove: { id: number; title: string } | null = null;

/** The latest file refactoring that Undo reverts. */
export function lastFileRefactoring() {
  return lastMove;
}

export type RefactorStatus = "done" | "cancelled" | "failed";

function describeMoves(moves: readonly FileMove[], label: string): string {
  if (moves.length !== 1) return `${label} ${moves.length} items`;
  const m = moves[0]!;
  return parentOf(m.from) === parentOf(m.to)
    ? `Rename '${nameOf(m.from)}' to '${nameOf(m.to)}'`
    : `Move '${nameOf(m.from)}' to '${nameOf(parentOf(m.to))}'`;
}

/**
 * Runs the refactoring. `onSearched` fires once references are collected (the
 * calling dialog closes then); `signal` cancels the search.
 */
export async function runFileRefactoring(
  moves: FileMove[],
  options: FileRefactorOptions,
  label: "Move" | "Rename",
  opts: { signal?: AbortSignal; onSearched?: () => void } = {},
): Promise<RefactorStatus> {
  if (!moves.length) return "cancelled";
  const backend = refactorBackend();
  const editor = maybeEditorService();
  // Servers and the text search read files from disk.
  if (editor && (options.references || options.textOccurrences)) await saveAllQuietly(editor);
  let collected: CollectedEdits = { edit: empty, errors: [] };
  try {
    if (options.references || options.textOccurrences) collected = await backend.edits(moves, options, opts.signal);
  } catch (e) {
    if (isCancelled(e) || opts.signal?.aborted) return "cancelled";
    collected = { edit: empty, errors: [e instanceof Error ? e.message : String(e)] };
  }
  if (opts.signal?.aborted) return "cancelled";
  opts.onSearched?.();
  const title = describeMoves(moves, label);
  let edit = collected.edit;
  if (touchesOtherFiles(edit, moves)) {
    const confirmed = await previewFileRefactoring({ title, edit, moves });
    if (!confirmed) return "cancelled";
    edit = confirmed;
  }
  let id: number;
  try {
    id = await withEditorsFollowing(
      () => backend.move(moves, edit, label),
      () => moves,
    );
  } catch (e) {
    notifications().notify({
      level: "error",
      title: `${label === "Move" ? "Cannot move" : "Cannot rename"} ${moves.length === 1 ? nameOf(moves[0]!.from) : `${moves.length} items`}`,
      body: e instanceof Error ? e.message : String(e),
    });
    return "failed";
  }
  lastMove = { id, title };
  if (collected.errors.length)
    notifications().notify({
      level: "warning",
      title: "Some references may not have been updated",
      body: collected.errors.join("\n"),
      key: "project.refactor.errors",
    });
  const edited = edit.files.length;
  notifications().notify({
    level: "info",
    title,
    body: edited ? `Updated references in ${edited} ${edited === 1 ? "file" : "files"}` : undefined,
    actions: [{ label: "Undo", run: () => void undoFileRefactoring(id) }],
    key: "project.refactor.done",
  });
  return "done";
}

/** Undo: moves the files back and reverts the reference updates. */
export async function undoFileRefactoring(id = lastMove?.id): Promise<boolean> {
  if (id === undefined) {
    notifications().notify({ level: "info", title: "Nothing to undo", key: "project.refactor.undo" });
    return false;
  }
  const backend = refactorBackend();
  let outcome: UndoOutcome;
  try {
    outcome = await withEditorsFollowing(
      () => backend.undo(id),
      (o) => o.moves,
    );
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot undo",
      body: e instanceof Error ? e.message : String(e),
      key: "project.refactor.undo",
    });
    return false;
  }
  if (lastMove?.id === id) lastMove = null;
  notifications().notify({
    level: outcome.conflicts.length ? "warning" : "info",
    title: "Refactoring undone",
    body: outcome.conflicts.length
      ? `Changed since the refactoring, not reverted: ${outcome.conflicts.map(nameOf).join(", ")}`
      : undefined,
    key: "project.refactor.done",
  });
  return true;
}
