/**
 * Project view › File Color: gives a file or folder its own background colour, kept as a
 * scope of that path and a File Colors entry in the project's settings.
 */
import { executeAction } from "@/platform/actions";
import { FILE_COLOR_NAMES, ownFileColor, pathPattern, withOwnFileColor } from "@/platform/fileColors";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings, relativePath, useProject } from "@/platform/project";
import type { MenuItem } from "@/ui";

const LABELS: Record<(typeof FILE_COLOR_NAMES)[number], string> = {
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  rose: "Rose",
  violet: "Violet",
  yellow: "Yellow",
  gray: "Gray",
};

export async function setFileColor(path: string, dir: boolean, color: string | null): Promise<void> {
  const { project, settings } = useProject.getState();
  if (!project || !isTauri()) return;
  const next = withOwnFileColor(settings, relativePath(project.root, path), dir, color);
  if (!next) return;
  await call(commands.settingsSet("project", "scopes", JSON.stringify(next.scopes)));
  await call(commands.settingsSet("project", "fileColors", JSON.stringify(next.fileColors)));
  await loadSettings();
}

/** The File Color submenu of a file or folder inside the project, or null when it can't have one. */
export function fileColorMenu(path: string, dir: boolean): MenuItem | null {
  const { project, settings } = useProject.getState();
  if (!project) return null;
  const rel = relativePath(project.root, path);
  if (rel === path || !pathPattern(rel, dir)) return null;
  const current = ownFileColor(rel, dir, settings)?.toLowerCase();
  return {
    id: "fileColor",
    label: "File Color",
    submenu: [
      ...FILE_COLOR_NAMES.map((name): MenuItem => ({
        id: name,
        label: LABELS[name],
        checked: current === name,
        run: () => void setFileColor(path, dir, name),
      })),
      { kind: "separator" },
      ...(current
        ? [{ id: "clear", label: "Clear File Color", run: () => void setFileColor(path, dir, null) } as MenuItem]
        : []),
      { id: "edit", label: "Edit File Colors…", run: () => void executeAction("file.settings", "fileColors") },
    ],
  };
}
