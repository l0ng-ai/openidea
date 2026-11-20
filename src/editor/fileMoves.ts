/** IDEA keeps editors on files that a refactoring moves or renames: they reopen at the new paths. */
import type { FileMove } from "@/bindings";
import { openEditorPaths } from "@/editor/api";
import { notifyFilesMoved, trackFileMove } from "@/platform/fileOps";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { isSameOrInside } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { maybeEditorService } from "@/workbench/contributions";

export async function saveAllQuietly(editor: { saveAll(): Promise<void> }) {
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

/** Moves in the opposite direction, last first: what Undo of `moves` does. */
export function reversedMoves(moves: readonly FileMove[]): FileMove[] {
  return [...moves].reverse().map((m) => ({ from: m.to, to: m.from }));
}

/**
 * Runs `run`, which moves the files `done` names, with the editors following: unsaved changes
 * are saved first (unless `save` is false), tabs reopen at the new paths.
 */
export async function withEditorsFollowing<T>(
  run: () => Promise<T>,
  done: (r: T) => readonly FileMove[],
  { save = true }: { save?: boolean } = {},
): Promise<T> {
  const projectRoot = () => useProject.getState().project?.root ?? null;
  const root = projectRoot();
  const editor = maybeEditorService();
  const openBefore = editor ? openEditorPaths() : [];
  if (editor && save) await saveAllQuietly(editor);
  const active = editor?.activePath() ?? null;
  const { result, applied } = await trackFileMove(root, async () => {
    const result = await run();
    const applied = done(result);
    if (root === projectRoot()) await notifyFilesMoved(applied);
    return { result, applied };
  });
  if (root !== projectRoot()) return result;
  const open = openBefore.filter((p) => applied.some((m) => isSameOrInside(p, m.from)));
  if (applied.length)
    emitLocalIdeEvent({
      type: "fsChanged",
      created: applied.map((m) => m.to),
      modified: [],
      removed: applied.map((m) => m.from),
    });
  if (!editor || !open.length) return result;
  // The editor closes tabs of removed files in a queue; an open that starts before an
  // active tab's close counts as superseded and stays in the background.
  for (const p of open) await editor.closePath?.(p).catch(() => false);
  const ordered = active && open.includes(active) ? [...open.filter((p) => p !== active), active] : open;
  for (const p of ordered) await editor.openFile(movedPath(p, applied), { focus: false }).catch(() => {});
  if (active && !open.includes(active)) await editor.openFile(active, { focus: false }).catch(() => {});
  return result;
}

/**
 * Editors follow `moves` that a workspace edit already made (a server's rename, Move, a quick
 * fix): called when the backend reports the edit, before the file watcher closes their tabs.
 */
export function editorsFollowAppliedMoves(moves: readonly FileMove[]): Promise<void> {
  if (!moves.length) return Promise.resolve();
  return withEditorsFollowing(
    () => Promise.resolve(),
    () => moves,
    { save: false },
  );
}
