/**
 * Files dropped from the OS onto a terminal: the path is pasted at the prompt
 * (shell-quoted when needed), separated by spaces, instead of the window-wide
 * drop (open in the editor, "Open project in" for a folder) or the browser /
 * shell falling through to a system dialog. Images are treated the same way:
 * showing the path is the expected behaviour.
 */
import { formatArgs } from "@/platform/commandLine";
import { usePlatform } from "@/platform/platformInfo";
import { isRemoteWindow } from "@/platform/remote";
import { registerFileDropHandler } from "@/workbench/fileDrop";

/** Shell-quoted paths for the prompt; the user presses Enter to execute. */
export function droppedPathsText(paths: readonly string[]): string {
  if (usePlatform.getState().os === "windows")
    return paths.map((p) => (/[\s&|<>()^]/.test(p) ? `"${p}"` : p)).join(" ");
  return formatArgs(paths);
}

/** Registers the terminal's drop handler; the disposer unregisters it. */
export function installTerminalDrop(host: HTMLElement, paste: (text: string) => void): () => void {
  return registerFileDropHandler((paths, x, y) => {
    if (!paths.length || isRemoteWindow()) return false;
    const el = document.elementFromPoint(x, y);
    if (!el || !host.contains(el)) return false;
    paste(droppedPathsText(paths));
    return true;
  });
}
