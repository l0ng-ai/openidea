/**
 * No focus ring on a control the user only clicked. The webview focuses a clicked button and
 * the focus outlives the click (across window-tab switches, and popups hand it back to their
 * trigger); the next keystroke then switches the engine to keyboard modality and rings a button
 * that was never reached by keyboard. Focus itself stays put (actions resolve their context from
 * it): a pressed control is marked, `global.css` drops the ring of marked controls, and moving
 * focus onto one with Tab or the arrow keys clears its mark.
 */
const CONTROL = "button, [role='button'], [role='tab'], a[href], summary";
const MARK = "data-pointer-focus";
const NAVIGATION = new Set(["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export function installPointerFocus(win: Window = window): () => void {
  const doc = win.document;
  let navigating = false;
  const onPointerDown = (e: PointerEvent) => {
    navigating = false;
    if (e.target instanceof Element) e.target.closest(CONTROL)?.setAttribute(MARK, "");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    navigating = NAVIGATION.has(e.key);
  };
  const onFocusIn = (e: FocusEvent) => {
    if (navigating && e.target instanceof Element) e.target.removeAttribute(MARK);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
  };
}
