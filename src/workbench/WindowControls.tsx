/**
 * Caption buttons (minimise, maximise / restore, close) for the frameless
 * title bar, on each side as the desktop lays them out (GTK's decoration
 * layout on Linux). Dialog windows (Settings) only have close, as in IDEA.
 */
import { type ComponentType, useEffect, useState } from "react";
import clsx from "clsx";
import { t } from "@/platform/i18n";
import { call, commands, type WindowButton } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { Icon } from "@/ui";
import styles from "./TitleBar.module.css";
import { captionButtons, type Side } from "./windowButtons";

type AppWindow = import("@tauri-apps/api/window").Window;

function withWindow(run: (w: AppWindow) => unknown) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => run(getCurrentWindow()));
}

function CloseButton() {
  return (
    <button
      type="button"
      className={clsx(styles.caption, styles.captionClose)}
      aria-label={t("window.caption.close")}
      title={t("window.caption.close")}
      onClick={() => withWindow((w) => w.close())}
    >
      <Icon name="window-close" size={16} />
    </button>
  );
}

function MinimizeButton() {
  return (
    <button
      type="button"
      className={styles.caption}
      aria-label={t("window.caption.minimize")}
      title={t("window.caption.minimize")}
      onClick={() => withWindow((w) => w.minimize())}
    >
      <Icon name="window-minimize" size={16} />
    </button>
  );
}

function MaximizeButton() {
  const [state, setState] = useState<"normal" | "maximized" | "fullscreen">("normal");

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    withWindow(async (w) => {
      const sync = () =>
        void Promise.all([w.isMaximized(), w.isFullscreen()]).then(
          ([maximized, fullscreen]) =>
            !disposed && setState(fullscreen ? "fullscreen" : maximized ? "maximized" : "normal"),
        );
      sync();
      const off = await w.onResized(sync);
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // In full screen the button restores the window: maximizing under the full-screen frame did
  // nothing visible and left the window broken once it was dragged (#6029).
  const restore = state !== "normal";
  const label = restore ? t("window.caption.restore") : t("window.caption.maximize");
  return (
    <button
      type="button"
      className={styles.caption}
      aria-label={label}
      title={label}
      onClick={() =>
        state === "fullscreen"
          ? void call(commands.windowToggleFullscreen()).catch((e) => console.warn("cannot leave full screen", e))
          : withWindow((w) => w.toggleMaximize())
      }
    >
      <Icon name={restore ? "window-restore" : "window-maximize"} size={16} />
    </button>
  );
}

const BUTTONS: Record<WindowButton, ComponentType> = {
  minimize: MinimizeButton,
  maximize: MaximizeButton,
  close: CloseButton,
};

export function WindowControls({ side, dialog = false }: { side: Side; dialog?: boolean }) {
  const layout = usePlatform((s) => s.windowButtons);
  const buttons = captionButtons(layout, side, dialog);
  if (buttons.length === 0) return null;
  return (
    <div className={clsx(styles.captions, side === "left" && styles.captionsLeft)}>
      {buttons.map((button) => {
        const Button = BUTTONS[button];
        return <Button key={button} />;
      })}
    </div>
  );
}
