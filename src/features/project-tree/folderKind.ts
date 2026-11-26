/** Folder icon kind in the project view, from the effective roots. */
import type { RootFolder } from "@/platform/languageSettings";
import type { BuildPresentation } from "@/platform/projectPresentation";
import type { FolderKind } from "@/ui";
import { directoryFolderKind, outputFolderKind } from "@/ui/folderPresentation";
import type { ProjectNode } from "./model";

export { outputFolderKind };

/**
 * Project Structure marks and roots detected from build files. Like IDEA, only
 * excluded folders get the excluded icon; git-ignored ones keep the plain one.
 */
export function folderKind(
  node: Pick<ProjectNode, "path" | "excluded">,
  roots: readonly RootFolder[],
  root: string | null,
  build?: BuildPresentation,
  detected: readonly RootFolder[] = [],
): FolderKind {
  return directoryFolderKind(node.path, roots, root, build, detected, !!node.excluded);
}
