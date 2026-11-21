import { useLayoutEffect } from "react";

const widthProperty = "--toolbar-label-width";

/** Short labels keep their full width. Divide the remaining space between the longer ones. */
function labelLimit(widths: number[], available: number): number | undefined {
  widths.sort((a, b) => a - b);
  for (const [index, width] of widths.entries()) {
    const limit = Math.max(0, Math.floor(available / (widths.length - index)));
    if (width > limit) return limit;
    available -= width;
  }
}

const pixels = (value: string) => Number.parseFloat(value) || 0;

function measureLabelWidth(toolbar: HTMLElement) {
  if (!toolbar.clientWidth) return;
  const children = Array.from(toolbar.children).filter((child) => child.getClientRects().length > 0);
  const labels = Array.from(toolbar.querySelectorAll<HTMLElement>("[data-toolbar-label]")).filter(
    (label) => label.getClientRects().length > 0,
  );
  const style = getComputedStyle(toolbar);
  const padding = pixels(style.paddingLeft) + pixels(style.paddingRight);
  const gaps = Math.max(0, children.length - 1) * pixels(style.columnGap);
  const occupied = children.reduce((sum, child) => {
    const childStyle = getComputedStyle(child);
    const width = child.hasAttribute("data-toolbar-spacer")
      ? pixels(childStyle.minWidth)
      : child.getBoundingClientRect().width;
    return sum + width + pixels(childStyle.marginLeft) + pixels(childStyle.marginRight);
  }, 0);
  const labelWidth = labels.reduce((sum, label) => sum + label.getBoundingClientRect().width, 0);
  const available = toolbar.clientWidth - padding - gaps - occupied + labelWidth;
  const preferredWidths = labels.map((label) => {
    const localMax = getComputedStyle(label).getPropertyValue("--toolbar-label-max");
    return Math.min(label.scrollWidth, pixels(localMax) || Infinity);
  });
  const limit = labelLimit(preferredWidths, available);
  // Below one em, the icon and tooltip identify the control more clearly than clipped text.
  const value = limit === undefined ? "" : `${limit < pixels(style.fontSize) ? 0 : limit}px`;
  if (toolbar.style.getPropertyValue(widthProperty) !== value) toolbar.style.setProperty(widthProperty, value);
}

export function useToolbarLabelWidth(toolbar: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!toolbar || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureLabelWidth(toolbar);
      });
    };
    const sizes = new ResizeObserver(schedule);
    const observeEntries = () => {
      sizes.disconnect();
      sizes.observe(toolbar);
      for (const child of toolbar.children) sizes.observe(child);
    };
    // A renamed label can stay the same size while clipped, so watch its text as well.
    const content = new MutationObserver((changes) => {
      if (changes.some((change) => change.target === toolbar)) observeEntries();
      schedule();
    });
    observeEntries();
    content.observe(toolbar, { childList: true, characterData: true, subtree: true });
    measureLabelWidth(toolbar);
    return () => {
      sizes.disconnect();
      content.disconnect();
      cancelAnimationFrame(frame);
      toolbar.style.removeProperty(widthProperty);
    };
  }, [toolbar]);
}
