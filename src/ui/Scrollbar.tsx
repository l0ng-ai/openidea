import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import clsx from "clsx";
import { lockScrollbarCursor } from "./dragCursor";
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
 * Pass `content` to observe its size or `contentHeight` to re-measure on demand.
 * `fullHeight` uses the height of the scrollbar's positioned parent.
 */
export function Scrollbar({
  target,
  content,
  contentHeight,
  fullHeight = false,
  minThumbSize = MIN_THUMB,
  trackRef,
}: {
  target: RefObject<HTMLElement | null>;
  content?: RefObject<HTMLElement | null>;
  contentHeight?: number;
  fullHeight?: boolean;
  minThumbSize?: number;
  trackRef?: RefObject<HTMLDivElement | null>;
}) {
  const ownTrack = useRef<HTMLDivElement>(null);
  const track = trackRef ?? ownTrack;
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<{ el: HTMLDivElement; pointerId: number; y: number; top: number; unlock: () => void } | null>(
    null,
  );
  const geometry = useRef<Geometry | null>(null);
  const endDrag = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.unlock();
    delete thumb.current?.dataset.dragging;
    if (current.el.hasPointerCapture(current.pointerId)) current.el.releasePointerCapture(current.pointerId);
  }, []);

  useLayoutEffect(() => {
    geometry.current = layout(target.current, track.current, thumb.current, fullHeight, minThumbSize);
  }, [target, track, fullHeight, minThumbSize, contentHeight]);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const sync = () => {
      geometry.current = layout(el, track.current, thumb.current, fullHeight, minThumbSize);
    };
    el.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (content?.current) observer.observe(content.current);
    if (fullHeight && track.current?.parentElement) observer.observe(track.current.parentElement);
    window.addEventListener("blur", endDrag);
    return () => {
      endDrag();
      window.removeEventListener("blur", endDrag);
      el.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [target, track, content, fullHeight, minThumbSize, endDrag]);

  return (
    <div
      ref={track}
      className={clsx(styles.track, fullHeight && styles.fullHeight)}
      aria-hidden
      onPointerDown={(e) => {
        const el = target.current;
        if (!el || e.button !== 0 || drag.current) return;
        e.preventDefault();
        // A click on the track pages towards it, as the native scrollbar does.
        if (e.target !== thumb.current) {
          const { top, bottom } = thumb.current!.getBoundingClientRect();
          if (e.clientY < top) scrollNow(el, el.scrollTop - el.clientHeight);
          else if (e.clientY > bottom) scrollNow(el, el.scrollTop + el.clientHeight);
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          el: e.currentTarget,
          pointerId: e.pointerId,
          y: e.clientY,
          top: el.scrollTop,
          unlock: lockScrollbarCursor(),
        };
        thumb.current!.dataset.dragging = "";
      }}
      onPointerMove={(e) => {
        const el = target.current;
        if (!el || drag.current?.pointerId !== e.pointerId) return;
        const g = geometry.current;
        if (g) scrollNow(el, drag.current.top + ((e.clientY - drag.current.y) / g.range) * g.max);
      }}
      onLostPointerCapture={(e) => {
        if (drag.current?.pointerId === e.pointerId) endDrag();
      }}
    >
      <div ref={thumb} className={styles.thumb} />
    </div>
  );
}

type Geometry = { range: number; max: number };

/** Positions the track over `el` and the thumb at its scroll offset; null when nothing scrolls. */
function layout(
  el: HTMLElement | null,
  t: HTMLElement | null,
  th: HTMLElement | null,
  fullHeight: boolean,
  minThumbSize: number,
): Geometry | null {
  if (!el || !t || !th) return null;
  const viewport = el.clientHeight;
  const height = fullHeight ? (t.parentElement?.clientHeight ?? 0) : viewport;
  const content = el.scrollHeight;
  const max = content - viewport;
  // WebKit can report scrollHeight a pixel over clientHeight after the scroller is resized to a
  // fractional height (dragging a splitter), with nothing overflowing: that is no scroll range.
  const scrolls = viewport > 0 && height > 1 && max > 1;
  t.style.top = fullHeight ? "" : `${el.offsetTop}px`;
  t.style.height = fullHeight ? "" : `${height}px`;
  t.style.display = scrolls ? "" : "none";
  if (!scrolls) return null;
  const size = Math.min(height - 1, Math.max(minThumbSize, (height * viewport) / content));
  const range = height - size;
  th.style.height = `${size}px`;
  th.style.transform = `translateY(${(Math.max(0, Math.min(max, el.scrollTop)) / max) * range}px)`;
  return { range, max };
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
