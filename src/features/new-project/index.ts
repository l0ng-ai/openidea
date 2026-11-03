import { registerActions } from "@/platform/actions";
import { registerOverlay } from "@/workbench/contributions";
import { NewProjectDialog } from "./NewProjectDialog";
import { useNewProjectStore } from "./store";

export function showNewProjectDialog() {
  useNewProjectStore.getState().openDialog();
}

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "newProject", component: NewProjectDialog }),
    registerActions([
      {
        id: "file.newProject",
        title: "New Project…",
        category: "File",
        icon: "folder",
        keywords: ["create project", "spring", "new project"],
        run: showNewProjectDialog,
      },
    ]),
  ];

  return () => disposers.reverse().forEach((d) => d());
}
