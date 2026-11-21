/**
 * macOS window buttons in the title bar's slot while the window fills the screen. Native full
 * screen moves the system's buttons into the bar revealed with the menu bar, so the slot kept for
 * them would be empty. Close closes this window (through the usual close guard), the green button
 * leaves full screen, minimize is disabled. Like the system's, they take no keyboard focus.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { t } from "@/platform/i18n";
import { commands } from "@/platform/ipc";
import { Icon } from "@/ui";
import styles from "./TitleBar.module.css";
import { useFullscreen } from "./useFullscreen";

function closeWindow() {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
}

export function MacWindowButtons() {
  const fullscreen = useFullscreen();
  const [active, setActive] = useState(() => document.hasFocus());
  useEffect(() => {
    if (!fullscreen) return;
    let disposed = false;
    const offs: (() => void)[] = [];
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      setActive(await w.isFocused());
      const off = await w.onFocusChanged(({ payload }) => {
        if (!disposed) setActive(payload);
      });
      if (disposed) off();
      else offs.push(off);
    });
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [fullscreen]);
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
