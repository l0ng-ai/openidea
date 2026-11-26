/**
 * The project colour gradient is centred on the Project widget's icon, as IDEA centres it, so it
 * follows the widget wherever Customize Main Toolbar puts it. The centre is written to the window
 * frame as `--project-gradient-x`; without the widget the gradient keeps the frame's corner.
 */
import { useLayoutEffect } from "react";

const PROPERTY = "--project-gradient-x";

/** Title bars that place the gradient: when one goes, the others place it again. */
const placers = new Set<() => void>();

/** Horizontal centre of `icon` in `frame`, in whole pixels. */
export function gradientCenter(frame: { left: number }, icon: { left: number; width: number }): number {
  return Math.round(icon.left + icon.width / 2 - frame.left);
}

/** Keeps the gradient on `bar`'s `[data-project-widget-icon]` whenever the bar or its entries change size. */
export function useProjectGradientAnchor(bar: HTMLElement | null, active: boolean) {
  useLayoutEffect(() => {
    if (!bar || !active || typeof ResizeObserver === "undefined") return;
    const frame = bar.closest<HTMLElement>("[data-project-frame]");
    if (!frame) return;
    let pending = 0;
    const place = () => {
      const icon = bar.querySelector<HTMLElement>("[data-project-widget-icon]");
      if (!icon) {
        frame.style.removeProperty(PROPERTY);
        return;
      }
      const x = gradientCenter(frame.getBoundingClientRect(), icon.getBoundingClientRect());
      frame.style.setProperty(PROPERTY, `${x}px`);
    };
    const schedule = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        place();
      });
    };
    const sizes = new ResizeObserver(schedule);
    // Entries move when anything before them in the bar changes size, spacers included.
    const observe = () => {
      sizes.disconnect();
      sizes.observe(bar);
      for (const child of bar.children) sizes.observe(child);
    };
    const content = new MutationObserver((changes) => {
      if (changes.some((change) => change.target === bar)) observe();
      schedule();
    });
    observe();
    content.observe(bar, { childList: true, characterData: true, subtree: true });
    placers.add(schedule);
    place();
    return () => {
      placers.delete(schedule);
      sizes.disconnect();
      content.disconnect();
      cancelAnimationFrame(pending);
      frame.style.removeProperty(PROPERTY);
      for (const other of placers) other();
    };
  }, [bar, active]);
}
