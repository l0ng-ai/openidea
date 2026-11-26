/**
 * The main toolbar's Center group sits in the middle of the bar, as IDEA's HorizontalLayout places
 * it: centred on the whole bar when the left and right groups leave room, otherwise pushed against
 * whichever group it would overlap.
 */
import { useLayoutEffect } from "react";

/**
 * Width of the spacer between the left group and the center group, given the bar's box, the center
 * group's width, where the spacer starts (plus the gap after it) and the free width both spacers share
 * (each keeps `min`).
 */
export function centerSpacerWidth(
  bar: { left: number; width: number },
  centerWidth: number,
  spacerLeft: number,
  free: number,
  min: number,
): number {
  const wanted = bar.left + (bar.width - centerWidth) / 2 - spacerLeft;
  return Math.max(min, Math.min(free - min, wanted));
}

/**
 * Keeps `[data-toolbar-center]` centred in `bar`: sizes the spacer before it
 * (`[data-toolbar-center-spacer]`) whenever the bar or its entries change size.
 */
export function useToolbarCenter(bar: HTMLElement | null, active: boolean) {
  useLayoutEffect(() => {
    if (!bar || !active || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const place = () => {
      const center = bar.querySelector<HTMLElement>(":scope > [data-toolbar-center]");
      const before = bar.querySelector<HTMLElement>(":scope > [data-toolbar-center-spacer]");
      const after = center?.nextElementSibling as HTMLElement | null;
      if (!center || !before || !after?.hasAttribute("data-toolbar-spacer")) return;
      // Measure with both spacers sharing the room equally, then hand the left one its share.
      before.style.removeProperty("flex");
      const box = bar.getBoundingClientRect();
      const spacer = before.getBoundingClientRect();
      const free = spacer.width + after.getBoundingClientRect().width;
      const min = Number.parseFloat(getComputedStyle(before).minWidth) || 0;
      // The bar's gap after the spacer also lies before the group.
      const gap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0;
      const width = centerSpacerWidth(box, center.getBoundingClientRect().width, spacer.left + gap, free, min);
      before.style.flex = `0 0 ${Math.round(width)}px`;
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const sizes = new ResizeObserver(schedule);
    const observe = () => {
      sizes.disconnect();
      sizes.observe(bar);
      for (const child of bar.children) if (!child.hasAttribute("data-toolbar-spacer")) sizes.observe(child);
    };
    const content = new MutationObserver((changes) => {
      if (changes.some((change) => change.target === bar)) observe();
      schedule();
    });
    observe();
    content.observe(bar, { childList: true, characterData: true, subtree: true });
    place();
    return () => {
      sizes.disconnect();
      content.disconnect();
      cancelAnimationFrame(frame);
      bar.querySelector<HTMLElement>(":scope > [data-toolbar-center-spacer]")?.style.removeProperty("flex");
    };
  }, [bar, active]);
}
