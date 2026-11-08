import { isSameOrInside } from "./paths";
import { basename, projectFolder, useProject } from "./project";
import { projectRelative, rootOfPath } from "./projectRoots";

export type PathKind = "absolute" | "relative" | "name" | "source";

/** Shared by the project view, editor tabs and the caret's copy chooser. */
export function pathToCopy(
  kind: PathKind,
  path: string,
  root: string | null = projectFolder(useProject.getState().project, path)?.root ?? null,
): string | null {
  if (kind === "absolute") return path;
  if (kind === "name") return basename(path);
  if (kind === "source") {
    const source = rootOfPath(path);
    const relative = projectRelative(path);
    if (!source || source.kind === "excluded" || relative === null) return null;
    return relative.slice(source.path.length + (source.path ? 1 : 0)) || ".";
  }
  if (!root || !isSameOrInside(path, root)) return path;
  return path.slice(root.length + (root.endsWith("/") ? 0 : 1)) || ".";
}
