/**
 * Files dropped from the OS or dragged from the Project view onto a terminal: the
 * path is pasted at the prompt (shell-quoted when needed), separated by spaces,
 * instead of the window-wide drop (open in the editor, "Open project in" for a
 * folder) or the browser / shell falling through to a system dialog. Images are
 * treated the same way: showing the path is the expected behaviour.
 */
import { formatArgs } from "@/platform/commandLine";
import { usePlatform } from "@/platform/platformInfo";
import { isRemoteWindow } from "@/platform/remote";
import { FILES_DRAG, registerDropTarget } from "@/ui";
import { registerFileDropHandler } from "@/workbench/fileDrop";

/** Shell-quoted paths for the prompt; the user presses Enter to execute. */
export function droppedPathsText(paths: readonly string[]): string {
  if (usePlatform.getState().os === "windows")
    return paths.map((p) => (/[\s&|<>()^]/.test(p) ? `"${p}"` : p)).join(" ");
  return formatArgs(paths);
}

/** Registers the terminal's drop handlers; the disposer unregisters them. */
export function installTerminalDrop(host: HTMLElement, paste: (text: string) => void): () => void {
  const removeOsDrop = registerFileDropHandler((paths, x, y) => {
    // A remote terminal can't reach this machine's files.
    if (!paths.length || isRemoteWindow()) return false;
    const el = document.elementFromPoint(x, y);
    if (!el || !host.contains(el)) return false;
    paste(droppedPathsText(paths));
    return true;
  });
  // Project view paths are the project's own, so they also hold in a remote terminal.
  const removeProjectDrop = registerDropTarget(host, {
    accepts: (type) => type === FILES_DRAG,
    over: () => {},
    leave: () => {},
    drop: (data) => {
      const paths = data.payload
        .split("\n")
        .filter(Boolean)
        .map((p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p));
      if (paths.length) paste(droppedPathsText(paths));
    },
  });
  return () => {
    removeOsDrop();
    removeProjectDrop();
  };
}
