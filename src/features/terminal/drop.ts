/**
 * Files dropped from the OS or dragged from the Project view onto a terminal: the
 * path is pasted at the prompt (shell-quoted when needed), separated by spaces,
 * instead of the window-wide drop (open in the editor, "Open project in" for a
 * folder) or the browser / shell falling through to a system dialog. Images are
 * treated the same way: showing the path is the expected behaviour.
 */
import { tx } from "@/platform/i18n";
import { usePlatform } from "@/platform/platformInfo";
import { isRemoteWindow } from "@/platform/remote";
import { FILES_DRAG, registerDropTarget } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { registerFileDropHandler } from "@/workbench/fileDrop";
import { dialectOf, quoteForShell } from "./quote";

/**
 * Paths quoted for the prompt of `shell`, or for the program's own input when none is known; the
 * user presses Enter to execute. Throws for a name that cannot be quoted safely.
 */
export function droppedPathsText(paths: readonly string[], shell?: string | null): string {
  const dialect = dialectOf(shell, usePlatform.getState().os === "windows");
  return paths.map((p) => quoteForShell(p, dialect)).join(" ");
}

/** Registers the terminal's drop handlers; the disposer unregisters them. */
export function installTerminalDrop(
  host: HTMLElement,
  paste: (text: string) => void,
  getTarget?: () => { shell: string } | null,
): () => void {
  const pasteDropped = (paths: readonly string[]) => {
    try {
      paste(droppedPathsText(paths, getTarget?.()?.shell));
    } catch (error) {
      notifications().notify({
        level: "error",
        title: tx("Cannot paste the dropped files"),
        body: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const removeOsDrop = registerFileDropHandler((paths, x, y) => {
    // A remote terminal can't reach this machine's files.
    if (!paths.length || isRemoteWindow()) return false;
    const el = document.elementFromPoint(x, y);
    if (!el || !host.contains(el)) return false;
    pasteDropped(paths);
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
      if (paths.length) pasteDropped(paths);
    },
  });
  return () => {
    removeOsDrop();
    removeProjectDrop();
  };
}
