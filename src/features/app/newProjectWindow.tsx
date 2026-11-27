/**
 * The New Project window (`new-project-<parent>`): the wizard in its own native window. The
 * created project opens from the parent project window, which then has it (or a new window).
 */
import { emitTo } from "@tauri-apps/api/event";
import { closeDialogWindow, useDialogWindow } from "@/workbench/dialogWindow";
import { OverlayHost } from "@/workbench/OverlayHost";
import { useApplyTheme } from "@/workbench/theme";
import { WindowResizeHandles } from "@/workbench/WindowResizeHandles";
import { NEW_PROJECT_CREATED, NewProjectDialog } from "./NewProject";

export function NewProjectWindow() {
  useApplyTheme();
  const parent = useDialogWindow((s) => s.parent);
  const created = async (dir: string) => {
    if (!parent) return;
    await emitTo(parent, NEW_PROJECT_CREATED, { dir });
    closeDialogWindow();
  };
  return (
    <>
      {parent && <NewProjectDialog standalone onClose={closeDialogWindow} onCreated={created} />}
      <OverlayHost />
      <WindowResizeHandles />
    </>
  );
}
