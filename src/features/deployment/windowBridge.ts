import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { editorService, type OpenOptions } from "@/workbench/contributions";
import { windowBackgroundHex } from "@/workbench/theme";

const OPEN_SOURCE = "openidea://deployment/open-source";

export function deploymentWindowParent(label = isTauri() ? getCurrentWebviewWindow().label : ""): string | null {
  return label.startsWith("deployment-") ? label.slice("deployment-".length) : null;
}

export function showDeploymentComparison(server: string, paths: string[]) {
  return call(commands.windowOpenDeployment(server, paths, windowBackgroundHex()));
}

export function openDeploymentSource(parent: string, path: string, options?: OpenOptions) {
  return emitTo(parent, OPEN_SOURCE, { path, options });
}

/** Jump to Source from the comparison opens the local file in its project's editor. */
export function installDeploymentEditorHost(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void getCurrentWebviewWindow()
    .listen<{ path: string; options?: OpenOptions }>(OPEN_SOURCE, ({ payload }) => {
      const root = useProject.getState().project?.root;
      if (root && payload.path.startsWith(`${root}/`)) {
        void editorService()
          .openFile(payload.path, payload.options)
          .then(() => getCurrentWebviewWindow().setFocus());
      }
    })
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
