/**
 * A dialog shown in its own native window. On macOS the optional sidebar runs the full height
 * of the window with the traffic lights over its top, and the title heads the content, above
 * the button row; there is no separate title strip. Windows and Linux are frameless
 * (tauri.<os>.conf.json), so a page-drawn title bar with the caption buttons sits on top there.
 * Esc and ⌘W cancel, like a dialog's Esc in the page.
 */
import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { DialogButtons, isPopupOpen, type DialogButton } from "@/ui";
import { useNativeTitlebar } from "./nativeTitlebar";
import { TitleBar } from "./TitleBar";
import { windowDragRegion } from "./window-drag";
import styles from "./WindowDialogFrame.module.css";

export function WindowDialogFrame({
  title,
  buttons,
  onCancel,
  sidebar,
  bodyClassName,
  children,
}: {
  title: string;
  buttons: readonly DialogButton[];
  /** Esc, ⌘W, and `cancel` buttons without their own handler. */
  onCancel: () => void;
  /** Full-height navigation on the left (a list of kinds, sources…). */
  sidebar?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const tx = useTx();
  const os = usePlatform((s) => s.os);
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const ref = useRef<HTMLElement>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  // The traffic lights centre on the header's height.
  useNativeTitlebar(frameless ? null : header);
  const cancel = useRef(onCancel);
  useLayoutEffect(() => {
    cancel.current = onCancel;
  });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, []);
  const windowTitle = tx(title);
  useEffect(() => {
    if (!isTauri()) return;
    void getCurrentWebviewWindow()
      .setTitle(windowTitle)
      .catch(() => {});
  }, [windowTitle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if ((e.key === "Escape" && !isPopupOpen()) || (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w")) {
        e.preventDefault();
        cancel.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section ref={ref} className={clsx(styles.window, os === "linux" && styles.windowEdge)} aria-label={windowTitle}>
      {frameless && <TitleBar minimal dialog title={windowTitle} />}
      <div className={styles.columns}>
        {sidebar !== undefined && (
          <aside className={styles.sidebar}>
            {!frameless && <div className={styles.sidebarTop} {...windowDragRegion} />}
            {sidebar}
          </aside>
        )}
        <div className={styles.main}>
          {!frameless && (
            <header
              ref={setHeader}
              className={clsx(styles.header, sidebar === undefined && styles.headerBesideLights)}
              {...windowDragRegion}
            >
              <h1 className={styles.title}>{windowTitle}</h1>
            </header>
          )}
          <div className={clsx(styles.body, bodyClassName)}>{children}</div>
          <footer className={styles.footer}>
            <DialogButtons buttons={buttons} onCancel={onCancel} />
          </footer>
        </div>
      </div>
    </section>
  );
}
