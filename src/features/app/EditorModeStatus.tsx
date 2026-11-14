/** Project status bar entry: switches this window to the file editor (LightEdit). */
import { executeAction } from "@/platform/actions";
import { useT } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { BarButton } from "@/ui";

export const APP_EDITOR_MODE = "app.editorMode";

export function EditorModeStatus() {
  const t = useT();
  const project = useProject((s) => s.project);
  if (!project) return null;
  return (
    <BarButton emphasis tooltip={t("app.editorMode.tooltip")} onClick={() => void executeAction(APP_EDITOR_MODE)}>
      {t("app.editorMode.label")}
    </BarButton>
  );
}
