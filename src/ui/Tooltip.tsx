/**
 * Tooltips are attribute-driven: any element with `data-tooltip` (and optional
 * `data-tooltip-shortcut`) gets one, shown by the single `<TooltipHost/>` after
 * 600ms of hover. Hidden on scroll, key press, pointer down or leave.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computePosition, flip, offset, shift } from "@floating-ui/react-dom";
import styles from "./Tooltip.module.css";
import { tx } from "@/platform/i18n";

export const TOOLTIP_DELAY = 600;
const WARM_MS = 400;

export function tooltipAttrs(text: string | undefined, shortcut?: string): Record<string, string> {
  if (!text) return {};
  const attrs: Record<string, string> = { "data-tooltip": text };
  if (shortcut) attrs["data-tooltip-shortcut"] = shortcut;
  return attrs;
}

interface Shown {
  text: string;
  shortcut?: string;
  x: number;
  y: number;
  placed: boolean;
}

export function TooltipHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastHidden = 0;
    let visible = false;

    const hide = () => {
      clearTimeout(timer);
      if (visible) lastHidden = performance.now();
      visible = false;
      anchorRef.current = null;
      setShown(null);
    };

    const show = (el: HTMLElement) => {
      const text = tx(el.dataset.tooltip);
      if (!text || !el.isConnected) return;
      visible = true;
      anchorRef.current = el;
      setShown({ text, shortcut: el.dataset.tooltipShortcut, x: -9999, y: -9999, placed: false });
    };

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]");
      if (!el) return;
      if (el === anchorRef.current) return;
      clearTimeout(timer);
      if (visible) {
        show(el);
        return;
      }
      const warm = performance.now() - lastHidden < WARM_MS;
      timer = setTimeout(() => show(el), warm ? 0 : TOOLTIP_DELAY);
      anchorRef.current = el;
    };

    const onOut = (e: PointerEvent) => {
      const el = anchorRef.current;
      if (!el) return;
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return;
      hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useEffect(() => {
    if (!shown || shown.placed) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    let cancelled = false;
    void computePosition(anchor, tip, {
      placement: "bottom",
      strategy: "fixed",
      middleware: [offset(6), flip({ padding: 6 }), shift({ padding: 6 })],
    }).then(({ x, y }) => {
      if (!cancelled) setShown((s) => (s ? { ...s, x, y, placed: true } : s));
    });
    return () => {
      cancelled = true;
    };
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className={styles.tooltip}
      data-placed={shown.placed || undefined}
      style={{ left: shown.x, top: shown.y }}
    >
      <span>{shown.text}</span>
      {shown.shortcut && <span className={styles.shortcut}>{shown.shortcut}</span>}
    </div>,
    document.body,
  );
}
