/** LightEdit status bar entry: opens the current file's folder as a full project. */
import { useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { useT } from "@/platform/i18n";
import { dirname, useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { BarButton } from "@/ui";

export const LIGHT_EDIT_OPEN_PROJECT = "lightEdit.openProject";

export function LightEditStatus() {
  const t = useT();
  const lightEdit = useProject((s) => s.lightEdit);
  const path = useEditorRegistry((s) => s.active?.ctx.path);
  if (!lightEdit) return null;
  const hasRealFile = !!path && !isVirtualUri(path);
  return (
    <BarButton
      emphasis
      tooltip={
        hasRealFile
          ? t("app.lightEdit.openProjectTooltip", { folder: dirname(path) })
          : t("app.lightEdit.pickFolderTooltip")
      }
      onClick={() => void executeAction(hasRealFile ? LIGHT_EDIT_OPEN_PROJECT : "file.openProject")}
    >
      {t("app.lightEdit.modeLabel")}
    </BarButton>
  );
}
