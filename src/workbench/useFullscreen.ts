/**
 * Whether this window fills the screen: native full screen, or a project tab shown in its
 * group's full-screen Space. Native full screen moves the system window buttons into the bar
 * revealed with the menu bar; the title bar draws its own while this is true.
 */
import { useEffect, useState } from "react";
import { commands, isTauri, onIdeEvent } from "@/platform/ipc";

export function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    // The plain-browser shell and tests have no Tauri window to ask.
    if (!isTauri()) return;
    let disposed = false;
    const sync = () =>
      void commands
        .windowIsFullscreen()
        .then((on) => !disposed && setFullscreen(on))
        .catch(() => {});
    sync();
    const off = onIdeEvent("windowFullscreenChanged", sync);
    return () => {
      disposed = true;
      off();
    };
  }, []);
  return fullscreen;
}
