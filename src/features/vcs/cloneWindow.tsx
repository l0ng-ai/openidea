/**
 * The Get from VCS window (`clone-<parent>`): the clone dialog in its own native window. The
 * cloned folder opens in the parent project window. A later Get from VCS with a URL (a
 * `x-github-client` link, say) fills it in here unless a clone is running.
 */
import { create } from "zustand";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { commands } from "@/platform/ipc";
import { closeDialogWindow, useDialogWindow } from "@/workbench/dialogWindow";
import { OverlayHost } from "@/workbench/OverlayHost";
import { useApplyTheme } from "@/workbench/theme";
import { WindowResizeHandles } from "@/workbench/WindowResizeHandles";
import { CLONED, CloneDialog } from "./clone";

/** Same event as `windows::LAUNCH_EVENT`: a pending launch (URL) is waiting. */
const LAUNCH_EVENT = "openidea://launch";

/** The launch's URL, with a key that remounts the form for each new one. */
const useLaunch = create<{ url: string; key: number } | null>(() => null);

/** Takes this window's launches: the first one, then each a later Get from VCS hands over. */
export function activateCloneLaunches(): () => void {
  let disposed = false;
  let off: (() => void) | undefined;
  const take = (first: boolean) =>
    void commands
      .windowTakeLaunch()
      .catch(() => null)
      .then((l) => {
        const url = l?.cloneUrl ?? "";
        if (!disposed && (first || url)) useLaunch.setState((prev) => ({ url, key: (prev?.key ?? 0) + 1 }), true);
      });
  take(true);
  void getCurrentWebviewWindow()
    .listen(LAUNCH_EVENT, () => take(false))
    .then((u) => (disposed ? u() : (off = u)));
  return () => {
    disposed = true;
    off?.();
  };
}

export function CloneWindow() {
  useApplyTheme();
  const parent = useDialogWindow((s) => s.parent);
  const launch = useLaunch();
  const cloned = async (dir: string) => {
    if (!parent) return;
    await emitTo(parent, CLONED, { dir });
    closeDialogWindow();
  };
  return (
    <>
      {parent && launch && (
        <CloneDialog
          key={launch.key}
          standalone
          initialUrl={launch.url}
          onClose={closeDialogWindow}
          onCloned={cloned}
        />
      )}
      <OverlayHost />
      <WindowResizeHandles />
    </>
  );
}
