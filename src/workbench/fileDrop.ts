/**
 * Files dropped from the OS onto the project window open in the editor, one
 * tab each; a dropped folder opens as a project (the "Open project in" policy
 * applies). Regions marked with `OWNS_FILE_DROP` (Project view, prompt box)
 * handle their drops themselves.
 */
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { editorService, OWNS_FILE_DROP } from "./contributions";

const OWNER_ATTR = Object.keys(OWNS_FILE_DROP)[0]!;

export interface FileDropDeps {
  isDir(path: string): Promise<boolean>;
  openFile(path: string, focus: boolean): Promise<void>;
  openProject(path: string): Promise<void>;
}

/** Whether a drop at CSS pixel (x, y) lands on a region that handles OS drops itself. */
export function dropOwnedAt(x: number, y: number): boolean {
  return !!document.elementFromPoint(x, y)?.closest(`[${OWNER_ATTR}]`);
}

/** Opens the dropped files (the last one focused), then the first dropped folder as a project. */
export async function openDropped(paths: readonly string[], deps: FileDropDeps): Promise<void> {
  const kinds = await Promise.all(paths.map((p) => deps.isDir(p).catch(() => false)));
  const files = paths.filter((_, i) => !kinds[i]);
  const dir = paths.find((_, i) => kinds[i]);
  for (const [i, path] of files.entries())
    await deps.openFile(path, i === files.length - 1).catch((e) => console.warn(`could not open ${path}`, e));
  if (dir) await deps.openProject(dir);
}

const defaultDeps: FileDropDeps = {
  isDir: (path) => call(commands.fsReadDir(path)).then(() => true),
  openFile: (path, focus) => editorService().openFile(path, { focus }),
  openProject: async (path) => void (await executeAction("file.openProjectPath", path)),
};

/** Handles one drop; null when it is left to another handler (no local project: the Welcome screen). */
export function handleFileDrop(
  paths: readonly string[],
  x: number,
  y: number,
  deps: FileDropDeps = defaultDeps,
): Promise<void> | null {
  if (!paths.length || !useProject.getState().project || isRemoteWindow() || dropOwnedAt(x, y)) return null;
  return openDropped(paths, deps);
}

export function installFileDrop(): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop") return;
        const ratio = window.devicePixelRatio || 1;
        void handleFileDrop(p.paths, p.position.x / ratio, p.position.y / ratio);
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      }),
  );
  return () => {
    disposed = true;
    unlisten?.();
  };
}
