import { useProject } from "@/platform/project";
import type { DiffData } from "./diffInput";

/** Project-relative path for labels. */
export function displayPath(path: string, root = useProject.getState().project?.root ?? null): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Diff of two files on disk; both sides are live, editable documents. */
export function compareFilesData(leftPath: string, rightPath: string): DiffData {
  return {
    path: rightPath,
    left: { type: "file", path: leftPath, label: displayPath(leftPath) },
    right: { type: "worktree", label: displayPath(rightPath) },
  };
}
