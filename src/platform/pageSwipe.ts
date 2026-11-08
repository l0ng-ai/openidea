import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauri } from "./ipc";
import { nativeDropPoint } from "./nativeDrop";

export type PageSwipe = "SwipeLeft" | "SwipeRight";
export const PAGE_SWIPE_EVENT = "ide:page-swipe";

export function isPageSwipe(stroke: unknown): stroke is PageSwipe {
  return stroke === "SwipeLeft" || stroke === "SwipeRight";
}

/** Preserve a whole scroll gesture inside wide content, even when it starts at an edge. */
export function ownsHorizontalScroll(element: Element | null): boolean {
  for (let el = element; el; el = el.parentElement) {
    // Terminal applications consume wheel events themselves (including alternate-screen apps).
    if (el.classList.contains("xterm") || el.hasAttribute("data-wheel-scroll")) return true;
    const overflow = getComputedStyle(el).overflowX;
    if (el.scrollWidth > el.clientWidth && /^(auto|scroll|overlay)$/.test(overflow)) return true;
  }
  return false;
}

export function installPageSwipeTracking(target: Window): () => void {
  const candidate = (event: Event) => {
    if (!isTauri()) return;
    const { id, x, y } = (event as CustomEvent<{ id: number; x: number; y: number }>).detail;
    const point = nativeDropPoint({ x, y });
    const element = target.document.elementFromPoint(point.x, point.y);
    if (!element || ownsHorizontalScroll(element)) return;
    void getCurrentWebviewWindow().emitTo(
      { kind: "WebviewWindow", label: getCurrentWebviewWindow().label },
      "ide://page-swipe-track",
      id,
    );
  };
  target.addEventListener("ide:page-swipe-candidate", candidate);
  return () => target.removeEventListener("ide:page-swipe-candidate", candidate);
}
