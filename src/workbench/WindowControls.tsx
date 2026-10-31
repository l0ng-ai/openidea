/**
 * Caption buttons (minimise, maximise / restore, close) for the frameless
 * title bar. Dialog windows (Settings) only have close, as in IDEA.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { t } from "@/platform/i18n";
import { Icon } from "@/ui";
import styles from "./TitleBar.module.css";

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

function SizeButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    withWindow(async (w) => {
      const sync = () => void w.isMaximized().then((m) => !disposed && setMaximized(m));
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

  const maximizeLabel = maximized ? t("window.caption.restore") : t("window.caption.maximize");
  return (
    <>
      <button
        type="button"
        className={styles.caption}
        aria-label={t("window.caption.minimize")}
        title={t("window.caption.minimize")}
        onClick={() => withWindow((w) => w.minimize())}
      >
        <Icon name="window-minimize" size={16} />
      </button>
      <button
        type="button"
        className={styles.caption}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        onClick={() => withWindow((w) => w.toggleMaximize())}
      >
        <Icon name={maximized ? "window-restore" : "window-maximize"} size={16} />
      </button>
    </>
  );
}

export function WindowControls({ dialog = false }: { dialog?: boolean }) {
  return (
    <div className={styles.captions}>
      {!dialog && <SizeButtons />}
      <CloseButton />
    </div>
  );
}
