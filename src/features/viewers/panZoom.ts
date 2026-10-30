/**
 * Pan/zoom for imperatively injected content (Mermaid output in the Markdown
 * preview). The preview scrolls, so only ⌘/Ctrl+wheel (and pinch) zooms; drag
 * pans once zoomed in, double-click resets. Listeners live as long as `viewport`.
 */
import { clampZoom, zoomAt, type View } from "./imageZoom";

const IDENTITY: View = { z: 1, x: 0, y: 0 };

export function attachPanZoom(viewport: HTMLElement): void {
  const pan = document.createElement("div");
  pan.className = "pan-zoom-content";
  pan.style.transformOrigin = "0 0";
  pan.append(...viewport.childNodes);
  viewport.append(pan);

  let view = IDENTITY;
  let drag: { id: number; x: number; y: number } | null = null;

  const apply = (next: View) => {
    if (next.z === 1 && view.z === 1) return;
    // Lock the height on first zoom so the page doesn't reflow while the content scales.
    if (view.z === 1 && !viewport.style.height) viewport.style.height = `${viewport.offsetHeight}px`;
    view = next;
    pan.style.transform =
      next.z === 1 && !next.x && !next.y ? "" : `translate(${next.x}px, ${next.y}px) scale(${next.z})`;
    viewport.dataset.zoomed = next.z === 1 ? "" : "true";
    if (next.z === 1 && !next.x && !next.y) viewport.style.height = "";
  };

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.deltaY) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 0 ? 0.01 : 0.33));
      apply(zoomAt(view, clampZoom(view.z * factor), e.clientX - rect.left, e.clientY - rect.top));
    },
    { passive: false },
  );
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || view.z <= 1) return;
    viewport.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    viewport.dataset.dragging = "true";
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
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
  viewport.addEventListener("dblclick", () => apply(IDENTITY));
}
