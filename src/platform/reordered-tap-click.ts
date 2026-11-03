/**
 * macOS WebKit routes mouse events through the input method while an editable element has
 * focus, and can hand the page a tap as `pointerup` -> `pointerdown` (WebKit bug 219670).
 * The press then has no release, so the tap's click is lost and the next tap's `pointerup`
 * pairs with this stale press instead. `pointerdown.timeStamp` stays native, so a press
 * stamped no later than the `pointerup` just before it is a reordered tap: finish it with
 * a synthetic `pointerup`/`mouseup`/`click`, and drop the wrongly paired click that follows.
 *
 * TODO: remove once the minimum supported macOS ships a WebKit with bug 219670 fixed (WebKit#76581).
 */
interface Options {
  win?: Window;
  /** Tests dispatch untrusted events. */
  isTrusted?: (e: Event) => boolean;
}

const primaryMouse = (e: PointerEvent) => e.pointerType === "mouse" && e.isPrimary && e.button === 0;

export function installReorderedTapClick({
  win = window,
  isTrusted: trusted = (e) => e.isTrusted,
}: Options = {}): () => void {
  // Events this shim dispatches must not be mistaken for the engine's.
  const own = new WeakSet<Event>();
  const isTrusted = (e: Event) => trusted(e) && !own.has(e);
  let lastUp: { time: number } | null = null;
  let pending: { target: Element; detail: number; x: number; y: number; mods: MouseEventInit } | null = null;
  // The click WebKit pairs with the stale press arrives right after the next real pointerup.
  let dropPaired = false;

  const onPointerUp = (e: PointerEvent) => {
    if (!isTrusted(e) || !primaryMouse(e)) return;
    lastUp = { time: e.timeStamp };
  };

  const onPointerDown = (e: PointerEvent) => {
    const before = lastUp;
    lastUp = null;
    dropPaired = false;
    pending = null;
    if (!isTrusted(e) || !primaryMouse(e) || !before || e.timeStamp > before.time) return;
    if (!(e.target instanceof Element)) return;
    pending = {
      target: e.target,
      detail: 1,
      x: e.clientX,
      y: e.clientY,
      mods: { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey },
    };
    // After this tick the page's own pointerdown/mousedown handlers have run, as for an in-order tap.
    setTimeout(finish);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (pending && isTrusted(e)) pending.detail = e.detail || 1;
  };

  const finish = () => {
    const tap = pending;
    pending = null;
    if (!tap?.target.isConnected) return;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 0,
      clientX: tap.x,
      clientY: tap.y,
      ...tap.mods,
    };
    const send = (e: Event) => {
      own.add(e);
      tap.target.dispatchEvent(e);
    };
    send(new PointerEvent("pointerup", { ...init, pointerType: "mouse", isPrimary: true }));
    send(new MouseEvent("mouseup", { ...init, detail: tap.detail }));
    send(new MouseEvent("click", { ...init, detail: tap.detail }));
    if (tap.detail === 2) send(new MouseEvent("dblclick", { ...init, detail: 2 }));
    dropPaired = true;
  };

  // Only mouse clicks (detail > 0); a keyboard-activated click is unrelated to the stale press.
  const dropIfPaired = (e: Event) => {
    if (!dropPaired || !isTrusted(e) || !((e as MouseEvent).detail > 0)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  const onClick = (e: Event) => {
    if (!isTrusted(e)) return;
    dropIfPaired(e);
    dropPaired = false;
  };

  const capture = { capture: true };
  win.addEventListener("pointerup", onPointerUp as EventListener, capture);
  win.addEventListener("pointerdown", onPointerDown as EventListener, capture);
  win.addEventListener("mousedown", onMouseDown as EventListener, capture);
  win.addEventListener("click", onClick, capture);
  win.addEventListener("dblclick", dropIfPaired, capture);
  return () => {
    win.removeEventListener("pointerup", onPointerUp as EventListener, capture);
    win.removeEventListener("pointerdown", onPointerDown as EventListener, capture);
    win.removeEventListener("mousedown", onMouseDown as EventListener, capture);
    win.removeEventListener("click", onClick, capture);
    win.removeEventListener("dblclick", dropIfPaired, capture);
  };
}
