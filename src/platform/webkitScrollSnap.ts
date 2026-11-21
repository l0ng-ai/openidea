/**
 * WebKitGTK scrolls overflow boxes on its scrolling thread by fractional touchpad deltas and
 * leaves the scrolled layer at that offset, while `scrollTop` reports it rounded. Text and
 * borders inside are then resampled between pixel rows and look blurry. Once a box stops
 * scrolling, moving it a pixel away and back puts the layer on whole pixels again.
 */
const SETTLE_MS = 150;

export function installWebKitScrollSnap(win: Window = window): () => void {
  const timers = new Map<Element, number>();
  // Boxes snapped this frame: the `scroll` events of the snap itself must not schedule another.
  const snapping = new WeakSet<Element>();

  const snap = (el: Element) => {
    timers.delete(el);
    if (!el.isConnected) return;
    const { scrollTop: top, scrollLeft: left } = el;
    snapping.add(el);
    // Away first, so the second write is a real move even at either end of the range.
    el.scrollTop = top > 0 ? top - 1 : top + 1;
    el.scrollLeft = left > 0 ? left - 1 : left + 1;
    el.scrollTop = top;
    el.scrollLeft = left;
    // Scroll events of a script scroll fire at the next rendering step, before its frame callbacks.
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => snapping.delete(el)));
  };
  const onScroll = (event: Event) => {
    const el = event.target;
    if (!(el instanceof Element) || snapping.has(el)) return;
    win.clearTimeout(timers.get(el));
    timers.set(
      el,
      win.setTimeout(() => snap(el), SETTLE_MS),
    );
  };

  win.document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    win.document.removeEventListener("scroll", onScroll, { capture: true });
    for (const id of timers.values()) win.clearTimeout(id);
    timers.clear();
  };
}
