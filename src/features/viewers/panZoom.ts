/**
 * Pan/zoom for imperatively injected content (Mermaid output in the Markdown
 * preview, and its full-screen view). ⌘/Ctrl+wheel zooms, so a plain wheel keeps
 * scrolling the page; drag pans once zoomed in (or always, with `panAlways`),
 * double-click resets. Listeners live as long as `viewport`.
 */
import { clampZoom, zoomAt, type View } from "./imageZoom";

const IDENTITY: View = { z: 1, x: 0, y: 0 };

interface PanZoomOptions {
  /** Pan on a drag at any zoom, not only once zoomed in (the full-screen view). */
  panAlways?: boolean;
  /**
   * The resting view. The full-screen view centres a fitted diagram with it, so
   * zooming anchors on the point under the cursor and a reset returns there.
   */
  origin?: View;
}

/** The `transform` of a view, empty at actual size in the top-left corner. */
const transformOf = (v: View) => (v.z === 1 && !v.x && !v.y ? "" : `translate(${v.x}px, ${v.y}px) scale(${v.z})`);

export function attachPanZoom(viewport: HTMLElement, options: PanZoomOptions = {}): void {
  const origin = options.origin ?? IDENTITY;
  const pan = document.createElement("div");
  pan.className = "pan-zoom-content";
  pan.style.transformOrigin = "0 0";
  pan.append(...viewport.childNodes);
  viewport.append(pan);
  pan.style.transform = transformOf(origin);
  if (options.panAlways) viewport.dataset.zoomed = "true";

  let view = origin;
  let drag: { id: number; x: number; y: number } | null = null;

  const apply = (next: View) => {
    const atOrigin = next.z === origin.z && next.x === origin.x && next.y === origin.y;
    if (next.z === view.z && next.x === view.x && next.y === view.y) return;
    // Lock the height on first zoom so the page doesn't reflow while the content scales.
    if (view.z === origin.z && !viewport.style.height) viewport.style.height = `${viewport.offsetHeight}px`;
    view = next;
    pan.style.transform = transformOf(next);
    viewport.dataset.zoomed = next.z > 1 || options.panAlways ? "true" : "";
    if (atOrigin) viewport.style.height = "";
  };

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.deltaY) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // One wheel notch (~100 px, 3 lines or a page) zooms about 15%; a trackpad
      // sends small pixel deltas, so zooming follows the gesture continuously.
      // The clamp keeps a fast flick from jumping too far in one event.
      const speed = e.deltaMode === 0 ? 0.0015 : e.deltaMode === 1 ? 0.05 : 0.15;
      const factor = Math.min(1.5, Math.max(2 / 3, Math.exp(-e.deltaY * speed)));
      apply(zoomAt(view, clampZoom(view.z * factor), e.clientX - rect.left, e.clientY - rect.top));
    },
    { passive: false },
  );
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (!options.panAlways && view.z <= 1)) return;
    viewport.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    viewport.dataset.dragging = "true";
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!(e.buttons & 1)) return end(e);
    apply({ ...view, x: view.x + e.clientX - drag.x, y: view.y + e.clientY - drag.y });
    drag = { ...drag, x: e.clientX, y: e.clientY };
  });
  const end = (e: PointerEvent) => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    delete viewport.dataset.dragging;
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
  viewport.addEventListener("dblclick", () => apply(origin));
}
