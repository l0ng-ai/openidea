/**
 * Tooltips are attribute-driven: any element with `data-tooltip` (and optional
 * `data-tooltip-shortcut`) gets one, shown by the single `<TooltipHost/>` after
 * 600ms of hover. Hidden on scroll, key press, pointer down or leave.
 *
 * Text cut off with an ellipsis gets one too, showing it whole, while it is cut off and
 * has no tooltip or `title` of its own.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { createPortal } from "react-dom";
import { computePosition, flip, offset, shift } from "@floating-ui/react-dom";
import styles from "./Tooltip.module.css";
import { tx } from "@/platform/i18n";

export const TOOLTIP_DELAY = 600;
const WARM_MS = 400;

/** `verbatim`: `text` is shown as written (already translated, or a plugin's own text). */
export function tooltipAttrs(text: string | undefined, shortcut?: string, verbatim?: boolean): Record<string, string> {
  if (!text) return {};
  const attrs: Record<string, string> = { "data-tooltip": text };
  if (shortcut) attrs["data-tooltip-shortcut"] = shortcut;
  if (verbatim) attrs["data-tooltip-verbatim"] = "";
  return attrs;
}

/** How far up from the hovered node an ellipsised text is looked for. */
const TRUNCATED_DEPTH = 4;

/** The element whose text is cut off with an ellipsis around `node`, up to `stop`, if any. */
function truncatedText(node: Element | null, stop: Element | null): HTMLElement | null {
  for (let el = node, depth = 0; el instanceof HTMLElement && depth < TRUNCATED_DEPTH; el = el.parentElement, depth++) {
    // A native tooltip shows instead, or the element opts out of auto-ellipsis tooltips.
    if (el.hasAttribute("title") || el.hasAttribute("data-no-tooltip")) return null;
    if (isTruncated(el)) return el;
    if (el === stop) break;
  }
  return null;
}

const isTruncated = (el: HTMLElement) =>
  el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis" && !!el.textContent?.trim();

/**
 * What the tooltip of `el` shows: its own text, and the whole of `cut`'s text while that is
 * cut off (with its own text beside it, when that says something else).
 */
function tooltipText(el: HTMLElement, cut: HTMLElement | null): { text: string; note?: string } | undefined {
  const own = el.dataset.tooltipVerbatim === undefined ? tx(el.dataset.tooltip) : el.dataset.tooltip;
  const whole = cut?.isConnected && isTruncated(cut) ? cut.textContent!.trim().replace(/\s+/g, " ") : undefined;
  if (!whole) return own ? { text: own, note: el.dataset.tooltipShortcut } : undefined;
  return { text: whole, note: own && !own.includes(whole) ? own : undefined };
}

interface Shown {
  text: string;
  shortcut?: string;
  x: number;
  y: number;
  placed: boolean;
  stripe?: "left" | "right";
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

    const show = (el: HTMLElement, cut: HTMLElement | null) => {
      const shows = el.isConnected ? tooltipText(el, cut) : undefined;
      if (!shows) return;
      visible = true;
      anchorRef.current = el;
      const stripe = el.dataset.tooltipStripe;
      setShown({
        text: shows.text,
        shortcut: shows.note,
        x: -9999,
        y: -9999,
        placed: false,
        stripe: stripe === "left" || stripe === "right" ? stripe : undefined,
      });
    };

    const onOver = (e: PointerEvent) => {
      const target = e.target as Element | null;
      const owner = target?.closest?.<HTMLElement>("[data-tooltip]") ?? null;
      // Cut-off text inside an element with a tooltip shows in that tooltip.
      const cut = truncatedText(target, owner);
      const el = owner ?? cut;
      if (!el) return;
      if (el === anchorRef.current) return;
      clearTimeout(timer);
      if (visible) {
        show(el, cut);
        return;
      }
      const warm = performance.now() - lastHidden < WARM_MS;
      timer = setTimeout(() => show(el, cut), warm ? 0 : TOOLTIP_DELAY);
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
      placement: shown.stripe === "right" ? "left" : shown.stripe === "left" ? "right" : "bottom",
      strategy: "fixed",
      middleware: [
        offset(6),
        flip({ padding: 6, ...(shown.stripe && { fallbackAxisSideDirection: "end" }) }),
        shift({ padding: 6 }),
      ],
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
      className={clsx(styles.tooltip, shown.stripe && styles.stripe)}
      data-placed={shown.placed || undefined}
      style={{ left: shown.x, top: shown.y }}
    >
      <span className={styles.text}>{shown.text}</span>
      {shown.shortcut && <span className={styles.shortcut}>{shown.shortcut}</span>}
    </div>,
    document.body,
  );
}
