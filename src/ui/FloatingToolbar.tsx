import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import styles from "./FloatingToolbar.module.css";

/** IDEA's editor overlays: mouse activity reveals them, keyboard focus keeps them available. */
export function FloatingToolbar({
  targetRef,
  children,
  className,
  hideOnTyping = true,
  retentionMs = 1400,
}: {
  targetRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  hideOnTyping?: boolean;
  retentionMs?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    const toolbar = ref.current;
    if (!target || !toolbar) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let returnFocus: HTMLElement | null = null;
    const clear = () => clearTimeout(timer);
    const focused = () => toolbar.contains(document.activeElement);
    const hide = () => {
      clear();
      if (!focused()) setVisible(false);
    };
    const move = (event: PointerEvent) => {
      clear();
      setVisible(true);
      if (!toolbar.contains(event.target as Node) && !focused()) timer = setTimeout(hide, retentionMs);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && focused()) {
        if (returnFocus?.isConnected) returnFocus.focus();
        else (document.activeElement as HTMLElement | null)?.blur();
      }
      if (event.key === "Escape" || (hideOnTyping && !toolbar.contains(event.target as Node))) hide();
    };
    const focus = (event: FocusEvent) => {
      if (focused()) {
        if (event.relatedTarget instanceof HTMLElement && !toolbar.contains(event.relatedTarget)) {
          returnFocus = event.relatedTarget;
        }
        clear();
        setVisible(true);
      }
    };
    const blur = (event: FocusEvent) => {
      if (!toolbar.contains(event.relatedTarget as Node | null)) {
        clear();
        setVisible(false);
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerleave", hide);
    target.addEventListener("keydown", key);
    toolbar.addEventListener("focusin", focus);
    toolbar.addEventListener("focusout", blur);
    return () => {
      clear();
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerleave", hide);
      target.removeEventListener("keydown", key);
      toolbar.removeEventListener("focusin", focus);
      toolbar.removeEventListener("focusout", blur);
    };
  }, [targetRef, hideOnTyping, retentionMs]);

  return (
    <div ref={ref} className={clsx(styles.toolbar, visible && styles.visible, className)}>
      {children}
    </div>
  );
}
