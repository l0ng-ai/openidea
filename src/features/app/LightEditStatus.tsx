/** LightEdit status bar entry: opens the current file's folder as a full project. */
import { useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { useT } from "@/platform/i18n";
import { dirname, useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { BarButton, Icon } from "@/ui";

export const LIGHT_EDIT_OPEN_PROJECT = "lightEdit.openProject";

export function LightEditStatus() {
  const t = useT();
  const lightEdit = useProject((s) => s.lightEdit);
  const path = useEditorRegistry((s) => s.active?.ctx.path);
  if (!lightEdit || !path || isVirtualUri(path)) return null;
  return (
    <BarButton
      emphasis
      tooltip={t("app.lightEdit.openProjectTooltip", { folder: dirname(path) })}
      onClick={() => void executeAction(LIGHT_EDIT_OPEN_PROJECT)}
    >
      <Icon name="folder-open" size={14} />
      {t("app.lightEdit.openProject")}
    </BarButton>
  );
}
