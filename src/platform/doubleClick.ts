/**
 * WebKit (the macOS webview) fires `dblclick` only for the second click of a burst: a
 * quick double-click right after another arrives as `click` with `detail` 3 and 4 and no
 * `dblclick`, so the second double-click on a folder, tab or row did nothing. This turns
 * every later even click of a burst into a `dblclick` on the same target, so React
 * `onDoubleClick` handlers (and their `stopPropagation`) see each double-click. An engine
 * that does fire its own `dblclick` for that click gets it suppressed as a duplicate.
 */
const synthetic = new WeakSet<Event>();

export function installRepeatedDoubleClick(win: Window = window): () => void {
  let last: { target: EventTarget; detail: number } | null = null;

  // Bubble phase on the window: after the page's own click handlers, like the engine's dblclick.
  const onClick = (e: MouseEvent) => {
    last = null;
    if (e.button !== 0 || e.detail < 4 || e.detail % 2 !== 0 || !e.target) return;
    const dbl = new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: e.view,
      detail: e.detail,
      screenX: e.screenX,
      screenY: e.screenY,
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      buttons: e.buttons,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
    synthetic.add(dbl);
    last = { target: e.target, detail: e.detail };
    e.target.dispatchEvent(dbl);
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (synthetic.has(e) || !last) return;
    const duplicate = e.detail === last.detail && e.target === last.target;
    last = null;
    if (!duplicate) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  win.addEventListener("click", onClick);
  win.addEventListener("dblclick", onDoubleClick, true);
  return () => {
    win.removeEventListener("click", onClick);
    win.removeEventListener("dblclick", onDoubleClick, true);
  };
}
