import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import styles from "./Scrollbar.module.css";

const MIN_THUMB = 32;

/** Class for the scroller: hides its native vertical scrollbar, which `Scrollbar` replaces. */
export const hideNativeScrollbar = styles.hideNative;

/**
 * A vertical scrollbar drawn in the DOM over `target` (place both in a
 * `position: relative` box). Dragging it sets `scrollTop` from pointer events,
 * so content rendered on scroll (virtual lists) lands in the same frame. The
 * native one scrolls asynchronously in WebKit and shows blank rows until the
 * page catches up.
 *
 * `contentHeight` re-measures when the scroller's content grows.
 */
export function Scrollbar({
  target,
  contentHeight,
}: {
  target: RefObject<HTMLElement | null>;
  contentHeight?: number;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; top: number } | null>(null);
  const geometry = useRef<Geometry | null>(null);

  useLayoutEffect(() => {
    geometry.current = layout(target.current, track.current, thumb.current);
  }, [target, contentHeight]);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const sync = () => {
      geometry.current = layout(el, track.current, thumb.current);
    };
    el.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [target]);

  return (
    <div
      ref={track}
      className={styles.track}
      aria-hidden
      onPointerDown={(e) => {
        const el = target.current;
        if (!el || e.button !== 0) return;
        e.preventDefault();
        // A click on the track pages towards it, as the native scrollbar does.
        if (e.target !== thumb.current) {
          const { top, bottom } = thumb.current!.getBoundingClientRect();
          if (e.clientY < top) scrollNow(el, el.scrollTop - el.clientHeight);
          else if (e.clientY > bottom) scrollNow(el, el.scrollTop + el.clientHeight);
          return;
        }
        drag.current = { y: e.clientY, top: el.scrollTop };
        thumb.current!.dataset.dragging = "";
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const el = target.current;
        if (!el || !drag.current) return;
        const g = geometry.current;
        if (g) scrollNow(el, drag.current.top + ((e.clientY - drag.current.y) / g.range) * g.max);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        delete thumb.current?.dataset.dragging;
      }}
    >
      <div ref={thumb} className={styles.thumb} />
    </div>
  );
}

type Geometry = { range: number; max: number };

/** Positions the track over `el` and the thumb at its scroll offset; null when nothing scrolls. */
function layout(el: HTMLElement | null, t: HTMLElement | null, th: HTMLElement | null): Geometry | null {
  if (!el || !t || !th) return null;
  const height = el.clientHeight;
  const max = el.scrollHeight - height;
  t.style.top = `${el.offsetTop}px`;
  t.style.height = `${height}px`;
  t.style.display = max > 0 ? "" : "none";
  if (max <= 0) return null;
  const size = Math.max(MIN_THUMB, (height * height) / el.scrollHeight);
  const range = height - size;
  th.style.height = `${size}px`;
  th.style.transform = `translateY(${(Math.min(max, el.scrollTop) / max) * range}px)`;
  return range > 0 ? { range, max } : null;
}

/**
 * Scrolls `el` and tells its scroll listeners at once. WebKit fires `scroll` for
 * a script scroll only at a later rendering step and may paint the new offset
 * first, so a virtual list would show a frame of blank rows mid-drag.
 */
function scrollNow(el: HTMLElement, top: number) {
  const before = el.scrollTop;
  el.scrollTo({ top, behavior: "instant" });
  if (el.scrollTop !== before) el.dispatchEvent(new Event("scroll"));
}
