import { useEffect, type RefObject } from "react";

/** How long the window must keep its size before a frozen element follows it. */
export const WINDOW_RESIZE_SETTLE_MS = 150;

/**
 * While the window is being resized, keeps the element at the size it had when the drag started,
 * on its own layer and clipped by its parent, then lets it take the new size once the drag pauses.
 * For dense views that WebKit cannot lay out and paint at every step of a live resize: their pixels
 * are moved instead of redrawn, so the rest of the window keeps up with the pointer.
 */
export function useFrozenWhileWindowResizes(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let frozen: { el: HTMLElement; parent: HTMLElement | null; parentOverflow: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      clearTimeout(timer);
      if (!frozen) return;
      const { el, parent, parentOverflow } = frozen;
      for (const p of ["width", "height", "flex", "will-change"]) el.style.removeProperty(p);
      if (parent) parent.style.overflow = parentOverflow;
      frozen = null;
    };
    const onResize = () => {
      const el = ref.current;
      if (!frozen && el?.isConnected) {
        const { width, height } = el.getBoundingClientRect();
        const parent = el.parentElement;
        frozen = { el, parent, parentOverflow: parent?.style.overflow ?? "" };
        el.style.setProperty("width", `${width}px`, "important");
        el.style.setProperty("height", `${height}px`, "important");
        el.style.setProperty("flex", "none", "important");
        el.style.setProperty("will-change", "transform");
        if (parent) parent.style.overflow = "hidden";
      }
      clearTimeout(timer);
      timer = setTimeout(release, WINDOW_RESIZE_SETTLE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      release();
    };
  }, [ref]);
}
