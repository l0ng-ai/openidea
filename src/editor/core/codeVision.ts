/** Code Vision switches (Settings › Editor › Inlay Hints › Code Vision) shared by its action and its rows' menu. */
import { executeAction } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";

type CodeVisionKey = "codeVision" | "codeVisionUsages" | "codeVisionAuthor";

export async function setCodeVisionSetting(key: CodeVisionKey, on: boolean): Promise<void> {
  try {
    useProject.setState({
      settings: await call(commands.settingsSet("global", `editor.inlay.${key}`, JSON.stringify(on))),
    });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot change the setting",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export const codeVisionShown = (): boolean => editorPrefs().inlay.codeVision;

/** Shows or hides every Code Vision row and hint at once, keeping the per-kind choices. */
export const toggleCodeVision = (): Promise<void> => setCodeVisionSetting("codeVision", !codeVisionShown());

/** Right-click on a Code Vision hint (IDEA's code vision context menu). `kind` is the clicked hint's `CodeLens.kind`. */
export function codeVisionMenuItems(kind: string | undefined): MenuItem[] {
  const own: MenuItem[] =
    kind === "usages"
      ? [{ label: "Hide Usages", run: () => void setCodeVisionSetting("codeVisionUsages", false) }]
      : kind === "author"
        ? [{ label: "Hide Code Author", run: () => void setCodeVisionSetting("codeVisionAuthor", false) }]
        : [];
  return [
    ...own,
    { label: "Hide Code Vision", run: () => void setCodeVisionSetting("codeVision", false) },
    { kind: "separator" },
    { label: "Code Vision Settings…", run: () => void executeAction("file.settings", "editor.inlayHints") },
  ];
}
