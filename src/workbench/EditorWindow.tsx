import { useState } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { usePlatform } from "@/platform/platformInfo";
import { EditorArea } from "./EditorArea";
import { OverlayHost } from "./OverlayHost";
import { StatusBar } from "./StatusBar";
import { ToolWindowLayout } from "./toolwindows/ToolWindows";
import { WindowControls } from "./WindowControls";
import { WindowResizeHandles } from "./WindowResizeHandles";
import { useNativeTitlebar } from "./nativeTitlebar";
import { windowDragRegion } from "./window-drag";
import { useApplyTheme } from "./theme";
import styles from "./EditorWindow.module.css";

export const useEditorFrame = create(() => ({ title: "", error: "", ready: false, committed: false, closing: false }));

export function EditorWindow() {
  useApplyTheme();
  const { title, error, ready, committed, closing } = useEditorFrame();
  const ownBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useNativeTitlebar(bar);
  return (
    <main className={styles.window} data-editor-window data-editor-ready={ready}>
      {ownBar && (
        <header ref={setBar} className={clsx(styles.caption, overlay && styles.overlay)} {...windowDragRegion}>
          {frameless && <WindowControls side="left" />}
          <span className={styles.title} {...windowDragRegion}>
            {title}
          </span>
          <span className={styles.drag} {...windowDragRegion} />
          {frameless && <WindowControls side="right" />}
        </header>
      )}
      <div className={styles.body} inert={!committed || closing}>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : (
          <ToolWindowLayout editor={<EditorArea />} />
        )}
      </div>
      <StatusBar lightEdit />
      <OverlayHost />
      <WindowResizeHandles />
    </main>
  );
}
