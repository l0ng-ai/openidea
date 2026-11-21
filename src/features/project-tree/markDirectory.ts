/** "Mark Directory as" (project view context menu): edits Settings › Project Structure. */
import { call, commands, isTauri } from "@/platform/ipc";
import {
  PROJECT_STRUCTURE_KEYS,
  effectiveRoots,
  markFolder,
  rootRole,
  validateProjectStructure,
  type FolderRole,
} from "@/platform/languageSettings";
import { attachedProjectOf, currentDetectedRoots, currentRoots } from "@/platform/projectRoots";
import { loadSettings, relativePath, useProject } from "@/platform/project";

/** Effective role of the folder: marked by the user or detected from a build file. */
export function directoryRole(path: string): FolderRole | null {
  const { project } = useProject.getState();
  if (!project) return null;
  const attached = attachedProjectOf(path);
  if (attached) {
    return rootRole(effectiveRoots(attached.detected, attached.structure), relativePath(attached.root, path));
  }
  return rootRole(currentRoots(), relativePath(project.root, path));
}

/**
 * Gives `path` the `role` (null = Unmark); written to the project's `.openidea/settings.toml`.
 * Unmarking a root detected from a build file keeps it unmarked across re-detection.
 */
export async function markDirectory(path: string, role: FolderRole | null): Promise<void> {
  const { project, settings } = useProject.getState();
  if (!project || !isTauri()) return;
  // A project attached to this one keeps its marks in its own settings.
  const attached = attachedProjectOf(path);
  if (attached) {
    const rel = relativePath(attached.root, path);
    if (rel === path) return;
    const next = markFolder(attached.structure, rel, role, attached.detected);
    for (const key of PROJECT_STRUCTURE_KEYS) {
      if (JSON.stringify(attached.structure[key]) !== JSON.stringify(next[key])) {
        await call(
          commands.projectWorkspaceMemberSet(attached.root, `projectStructure.${key}`, JSON.stringify(next[key])),
        );
      }
    }
    return;
  }
  const rel = relativePath(project.root, path);
  if (rel === path) return;
  const before = validateProjectStructure(settings?.projectStructure);
  const next = markFolder(before, rel, role, currentDetectedRoots());
  for (const key of PROJECT_STRUCTURE_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(next[key])) {
      await call(commands.settingsSet("project", `projectStructure.${key}`, JSON.stringify(next[key])));
    }
  }
  await loadSettings();
}
