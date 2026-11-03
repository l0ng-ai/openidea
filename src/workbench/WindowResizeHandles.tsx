/**
 * Frameless-window resize handles: Windows gives undecorated windows no
 * resize borders, so the title bar's frameless look leaves the window
 * stuck at its launch size. Eight invisible hit areas along the edges
 * start a native resize drag, like any other desktop app.
 *
 * macOS renders its own overlay title bar but still provides resize
 * handles, so nothing is added there.
 */
import { useEffect, useState } from "react";
import { usePlatform } from "@/platform/platformInfo";
import { isTauri } from "@/platform/ipc";
import styles from "./WindowResizeHandles.module.css";

type Dir = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const EDGES: { dir: Dir; cls: string }[] = [
  { dir: "North", cls: styles.n! },
  { dir: "South", cls: styles.s! },
  { dir: "East", cls: styles.e! },
  { dir: "West", cls: styles.w! },
  { dir: "NorthEast", cls: styles.ne! },
  { dir: "NorthWest", cls: styles.nw! },
  { dir: "SouthEast", cls: styles.se! },
  { dir: "SouthWest", cls: styles.sw! },
];

async function start(dir: Dir) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(dir);
}

export function WindowResizeHandles() {
  // A frameless window needs them; a decorated one already has native borders.
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const enabled = isTauri() && frameless;
  // A maximized or full-screen window has nothing to resize; the edges belong to the content.
  const [sized, setSized] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const sync = () =>
        void Promise.all([w.isMaximized(), w.isFullscreen()]).then(([m, f]) => !disposed && setSized(m || f));
      sync();
      const off = await w.onResized(sync);
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
  if (!enabled || sized) return null;
  return (
    <>
      {EDGES.map(({ dir, cls }) => (
        <div
          key={dir}
          className={cls}
          aria-hidden="true"
          onMouseDown={(e) => {
            // Left button only, and not on something interactive that bubbled up.
            if (e.button !== 0) return;
            e.preventDefault();
            void start(dir);
          }}
        />
      ))}
    </>
  );
}
