import type { FileStatus } from "@/bindings";
import { renamedFromPath } from "./changes";
import type { DiffData, DiffSide } from "./diffInput";
import { isIntentToAdd } from "./staging";
import { existsOnDisk, repoOf, useVcs } from "./store";

export const SHOW_THREE_SIDE_DIFF = "vcs.showThreeSideDiff";

const absent = (label: string): DiffSide => ({ type: "text", text: "", label, absent: true });

export function stagingVersions(file: FileStatus): (DiffData & { middle: DiffSide }) | undefined {
  if (file.staged === "ignored" || file.unstaged === "ignored") return;
  const path = file.path;
  const root = repoOf(path);
  const oldPath = renamedFromPath(file) ?? undefined;
  const untracked = file.unstaged === "untracked";
  const intentToAdd = isIntentToAdd(file);
  const hasHead =
    !untracked &&
    !intentToAdd &&
    file.staged !== "added" &&
    (!root || useVcs.getState().heads[root]?.headCommit !== null);
  const hasIndex =
    !untracked &&
    !intentToAdd &&
    file.staged !== "deleted" &&
    file.unstaged !== "conflicted" &&
    file.staged !== "conflicted";
  return {
    path,
    left: hasHead ? { type: "rev", rev: "HEAD", path: oldPath, label: "HEAD" } : absent("HEAD"),
    middle: hasIndex
      ? {
          type: "rev",
          rev: ":0",
          path: file.staged !== "renamed" ? oldPath : undefined,
        }
      : absent("Staged (index)"),
    right: existsOnDisk(file) ? { type: "worktree", label: "Local Version" } : absent("Local Version"),
  };
}
