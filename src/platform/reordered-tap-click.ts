/**
 * macOS WebKit routes mouse events through the input method while an editable element has
 * focus, and with a third-party input method it can hand the page a tap as `pointerup` ->
 * `pointerdown` (WebKit bug 219670). The press then has no release: the tap's click is lost,
 * and the engine, which still considers the button down, starts the next tap with a bare
 * `mousedown` (no `pointerdown`). `pointerdown.timeStamp` stays native, so a press stamped before
 * the `pointerup` just before it is a reordered tap: finish it with a synthetic
 * `pointerup`/`mouseup`/`click`, and give the next press the `pointerdown` the engine skips.
 * The next tap's own click lands on its own target, so it is left alone.
 *
 * TODO: remove once the minimum supported macOS ships a WebKit with bug 219670 fixed (WebKit#76581).
 */
interface Options {
  win?: Window;
  /** Tests dispatch untrusted events. */
  isTrusted?: (e: Event) => boolean;
}

const primaryMouse = (e: PointerEvent) => e.pointerType === "mouse" && e.isPrimary && e.button === 0;

/** The engine's id of the mouse pointer (the only one a reordered tap concerns). */
const MOUSE_POINTER_ID = 1;

export function installReorderedTapClick({
  win = window,
  isTrusted: trusted = (e) => e.isTrusted,
}: Options = {}): () => void {
  // Events this shim dispatches must not be mistaken for the engine's.
  const own = new WeakSet<Event>();
  const isTrusted = (e: Event) => trusted(e) && !own.has(e);
  const send = (target: Element, e: Event) => {
    own.add(e);
    target.dispatchEvent(e);
  };
  let lastUp: number | null = null;
  // A pointer is down as far as the page has been told; a mouse press without one is a skipped pointerdown.
  let down = false;
  let pending: { target: Element; detail: number; x: number; y: number; mods: MouseEventInit } | null = null;

  const mods = (e: MouseEvent): MouseEventInit => ({
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  });

  const onPointerUp = (e: PointerEvent) => {
    if (!isTrusted(e)) return;
    down = false;
    if (!primaryMouse(e)) return;
    lastUp = e.timeStamp;
    // The engine released the press itself, so it was not a stale one: there is nothing to finish.
    pending = null;
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (isTrusted(e)) down = false;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!isTrusted(e)) return;
    down = true;
    const before = lastUp;
    lastUp = null;
    pending = null;
    // A quick in-order click can stamp its press with its last release's time: only an earlier press is stale.
    if (!primaryMouse(e) || before === null || e.timeStamp >= before) return;
    if (!(e.target instanceof Element)) return;
    pending = { target: e.target, detail: 1, x: e.clientX, y: e.clientY, mods: mods(e) };
    // After this tick the page's own pointerdown/mousedown handlers have run, as for an in-order tap.
    setTimeout(finish);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!isTrusted(e) || e.button !== 0) return;
    if (pending) {
      pending.detail = e.detail || 1;
      return;
    }
    if (down || !(e.target instanceof Element)) return;
    down = true;
    send(
      e.target,
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: MOUSE_POINTER_ID,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ...mods(e),
      }),
    );
  };

  const finish = () => {
    const tap = pending;
    pending = null;
    if (!tap) return;
    down = false;
    if (!tap.target.isConnected) return;
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
    send(
      tap.target,
      new PointerEvent("pointerup", { ...init, pointerId: MOUSE_POINTER_ID, pointerType: "mouse", isPrimary: true }),
    );
    send(tap.target, new MouseEvent("mouseup", { ...init, detail: tap.detail }));
    send(tap.target, new MouseEvent("click", { ...init, detail: tap.detail }));
    if (tap.detail === 2) send(tap.target, new MouseEvent("dblclick", { ...init, detail: 2 }));
  };

  const capture = { capture: true };
  win.addEventListener("pointerup", onPointerUp as EventListener, capture);
  win.addEventListener("pointercancel", onPointerCancel as EventListener, capture);
  win.addEventListener("pointerdown", onPointerDown as EventListener, capture);
  win.addEventListener("mousedown", onMouseDown as EventListener, capture);
  return () => {
    win.removeEventListener("pointerup", onPointerUp as EventListener, capture);
    win.removeEventListener("pointercancel", onPointerCancel as EventListener, capture);
    win.removeEventListener("pointerdown", onPointerDown as EventListener, capture);
    win.removeEventListener("mousedown", onMouseDown as EventListener, capture);
  };
}
