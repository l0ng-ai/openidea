/**
 * macOS window buttons in the title bar's slot while the window fills the screen. Native full
 * screen moves the system's buttons into the bar revealed with the menu bar, and a project tab
 * shown in its group's full-screen Space has none, so the slot kept for them would be empty.
 * Close closes this project's tab, the green button leaves full screen, minimize is disabled.
 * Like the system's, they take no keyboard focus.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { t } from "@/platform/i18n";
import { commands, onIdeEvent } from "@/platform/ipc";
import { Icon } from "@/ui";
import styles from "./TitleBar.module.css";

type AppWindow = import("@tauri-apps/api/window").Window;

function useFullscreenWindow(): { fullscreen: boolean; active: boolean } {
  const [fullscreen, setFullscreen] = useState(false);
  const [active, setActive] = useState(() => document.hasFocus());
  useEffect(() => {
    let disposed = false;
    const offs: (() => void)[] = [];
    const sync = () => void commands.windowIsFullscreen().then((on) => !disposed && setFullscreen(on));
    sync();
    offs.push(onIdeEvent("windowFullscreenChanged", sync));
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w: AppWindow = getCurrentWindow();
      const listeners = await Promise.all([
        w.onResized(sync),
        w.onFocusChanged(({ payload }) => {
          setActive(payload);
          sync();
        }),
      ]);
      if (disposed) listeners.forEach((off) => off());
      else offs.push(...listeners);
    });
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, []);
  return { fullscreen, active };
}

function closeWindow() {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
}

export function MacWindowButtons() {
  const { fullscreen, active } = useFullscreenWindow();
  if (!fullscreen) return null;
  return (
    <div
      className={clsx(styles.macButtons, !active && styles.macButtonsInactive)}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        tabIndex={-1}
        className={clsx(styles.macButton, styles.macClose)}
        aria-label={t("window.caption.close")}
        onClick={closeWindow}
      >
        <Icon name="mac-window-close" size={8} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={clsx(styles.macButton, styles.macMinimize)}
        aria-label={t("window.caption.minimize")}
        disabled
      >
        <Icon name="mac-window-minimize" size={8} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={clsx(styles.macButton, styles.macZoom)}
        aria-label={t("window.caption.exitFullScreen")}
        onClick={() => void commands.windowToggleFullscreen()}
      >
        <Icon name="mac-window-exit-full-screen" size={8} />
      </button>
    </div>
  );
}
