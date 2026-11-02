/** Content of the native Settings window: title bar, page tree + page, buttons. */
import clsx from "clsx";
import { useEffect, useRef } from "react";
import { OverlayHost } from "@/workbench/OverlayHost";
import { usePlatform } from "@/platform/platformInfo";
import { TitleBar } from "@/workbench/TitleBar";
import { useApplyTheme } from "@/workbench/theme";
import { SettingsFooter, SettingsLayout, useSettingsTitle } from "../dialog/SettingsDialog";
import { useSettingsDialog } from "../model/staging";
import styles from "../dialog/SettingsDialog.module.css";

export function SettingsWindow() {
  useApplyTheme();
  const os = usePlatform((s) => s.os);
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  const open = useSettingsDialog((s) => s.open);
  const title = useSettingsTitle();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div ref={ref} className={clsx(styles.window, os === "linux" && styles.windowEdge)}>
      {/* macOS overlays traffic lights on it; Windows and Linux are frameless (tauri.<os>.conf.json). */}
      {ownTitleBar && <TitleBar minimal dialog title={title} />}
      {open && (
        <>
          <div className={styles.windowBody}>
            <SettingsLayout />
          </div>
          <div className={styles.windowFooter}>
            <SettingsFooter />
          </div>
        </>
      )}
      <OverlayHost />
    </div>
  );
}
