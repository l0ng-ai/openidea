/**
 * Long press opens the context menu on a touch screen. iOS WebKit never fires
 * `contextmenu` for a long press, so after a still finger press this dispatches
 * one at the press point; components keep handling `onContextMenu` as for a
 * right click. Android WebView fires its own: when that comes first ours is
 * dropped, and when ours came first the native one is swallowed. The click the
 * engine sends when the finger lifts is swallowed too, so the press doesn't also
 * activate what it opened the menu on.
 *
 * Text fields and the code editor keep the system's long press (text selection
 * and the edit menu) while typed in; the editor opened for reading gets the menu.
 */
export const LONG_PRESS_MS = 500;
/** A finger that moves farther than this (CSS px) is scrolling, not pressing. */
export const LONG_PRESS_SLOP = 10;

/** Fields being typed in; one without a keyboard (`inputmode="none"`, the editor read on a phone) isn't. */
const EDITABLE =
  "input:not([inputmode='none']), textarea:not([inputmode='none']), select, [contenteditable]:not([contenteditable='false']):not([inputmode='none'])";

interface Options {
  win?: Window;
  delay?: number;
  /** Tests dispatch untrusted events. */
  isTrusted?: (e: Event) => boolean;
}

interface Press {
  pointerId: number;
  target: Element;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The menu opened: ours dispatched or the engine's arrived. */
  opened: "ours" | "native" | null;
}

const fingerLike = (e: PointerEvent) => e.pointerType === "touch" || e.pointerType === "pen";

export function installLongPressContextMenu({
  win = window,
  delay = LONG_PRESS_MS,
  isTrusted: trusted = (e) => e.isTrusted,
}: Options = {}): () => void {
  const doc = win.document;
  const own = new WeakSet<Event>();
  const isNative = (e: Event) => trusted(e) && !own.has(e);
  let press: Press | null = null;
  /** Swallow the click that ends a press whose menu we opened. */
  let swallowClick = false;

  const stopTimer = () => {
    if (press?.timer != null) clearTimeout(press.timer);
    if (press) press.timer = null;
  };
  const end = () => {
    stopTimer();
    press = null;
  };

  const fire = () => {
    const p = press;
    if (!p) return;
    p.timer = null;
    if (!p.target.isConnected) return end();
    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: p.clientX,
      clientY: p.clientY,
      screenX: p.screenX,
      screenY: p.screenY,
    });
    own.add(menu);
    p.opened = "ours";
    swallowClick = true;
    p.target.dispatchEvent(menu);
  };

  const onDown = (e: PointerEvent) => {
    end();
    swallowClick = false;
    if (!fingerLike(e) || !e.isPrimary || !isNative(e)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(EDITABLE)) return;
    press = {
      pointerId: e.pointerId,
      target,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      timer: setTimeout(fire, delay),
      opened: null,
    };
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.pointerId || press.opened) return;
    if (Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) > LONG_PRESS_SLOP) end();
  };
  const onUp = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) end();
  };
  const onCancel = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) {
      end();
      swallowClick = false;
    }
  };
  const onScroll = () => {
    if (press && !press.opened) end();
  };
  const onContextMenu = (e: MouseEvent) => {
    if (!isNative(e) || !press) return;
    if (press.opened === "ours") {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    stopTimer();
    press.opened = "native";
  };
  const onClick = (e: MouseEvent) => {
    if (!swallowClick || !isNative(e)) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const capture = { capture: true } as const;
  doc.addEventListener("pointerdown", onDown, capture);
  doc.addEventListener("pointermove", onMove, capture);
  doc.addEventListener("pointerup", onUp, capture);
  doc.addEventListener("pointercancel", onCancel, capture);
  doc.addEventListener("contextmenu", onContextMenu, capture);
  doc.addEventListener("click", onClick, capture);
  win.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    end();
    doc.removeEventListener("pointerdown", onDown, capture);
    doc.removeEventListener("pointermove", onMove, capture);
    doc.removeEventListener("pointerup", onUp, capture);
    doc.removeEventListener("pointercancel", onCancel, capture);
    doc.removeEventListener("contextmenu", onContextMenu, capture);
    doc.removeEventListener("click", onClick, capture);
    win.removeEventListener("scroll", onScroll, capture);
  };
}
