import type { StashDiffTarget } from "@/bindings";
import { editorsFor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { openDiff, openVcsDiff, withChain, type DiffData } from "./diffInput";
import type { LogChange } from "./logChanges";

export interface StashDiffRequest {
  index: number;
  changes: readonly LogChange[];
  chain: readonly LogChange[];
  /** The modal stash review always compares with local and shows its diff in front. */
  dialogLifetime?: AbortSignal;
}

async function hasWorkingFile(path: string): Promise<boolean> {
  if (editorsFor(path).length) return true;
  return call(commands.fsEntryKind(path)).then(
    (kind) => kind !== "dir",
    () => false,
  );
}

async function stashFileDiff(change: LogChange, label: string, target: StashDiffTarget): Promise<DiffData | null> {
  const { path, left: parent, right: saved } = change.diff;
  const right = saved.type === "rev" ? { ...saved, label } : saved;
  if (target === "parent") return { ...change.diff, right };

  // A rename saved in the stash may still have its original path in the working tree.
  const before = parent.type === "rev" ? parent.path : undefined;
  const localPath = (await hasWorkingFile(path)) ? path : before && (await hasWorkingFile(before)) ? before : null;
  if (!localPath && right.type === "text" && right.absent) return null;
  const left: DiffData["left"] =
    localPath === path
      ? { type: "worktree", label: "Local Version" }
      : localPath
        ? { type: "file", path: localPath, label: "Local Version" }
        : { type: "text", text: "", label: "(does not exist)", absent: true };
  return { path, left, right };
}

/** The stash's diff chain, with a local side that follows the editor buffer; null when no file has one. */
export async function stashDiffData(request: StashDiffRequest, target: StashDiffTarget): Promise<DiffData | null> {
  const { changes, chain, dialogLifetime } = request;
  if (!changes.length) return null;
  const files = chain.includes(changes[0]!) ? chain : changes;
  const saved = `stash@{${request.index}}`;
  const results = await Promise.all(
    files.map(async (file) => ({ file, diff: await stashFileDiff(file, saved, dialogLifetime ? "local" : target) })),
  );
  const ready = results.flatMap(({ file, diff }) => (diff ? [{ file, diff }] : []));
  const selected = new Set(changes);
  const index = ready.findIndex(({ file }) => selected.has(file));
  if (index < 0) return null;
  return withChain(
    ready.map((item) => item.diff),
    index,
  );
}

/** Shows the stash's diff chain: in front of the modal stash review, else in the editor. */
export async function showStashDiff(request: StashDiffRequest, target: StashDiffTarget, preview?: AbortSignal) {
  const { dialogLifetime } = request;
  const signal = dialogLifetime ?? preview;
  if (signal?.aborted) return;
  const diff = await stashDiffData(request, target);
  if (!diff || signal?.aborted) return;
  if (dialogLifetime) {
    const { openDiffDialog } = await import("./diffDialog");
    if (!dialogLifetime.aborted) openDiffDialog(diff);
  } else if (preview) await openDiff(diff, { preview: true, focus: false });
  else await openVcsDiff(diff, { preview: true });
}
