/** Popups belong to the editor; defer save cleanup until focus leaves them too. */
export function saveOnBlur(hasFocus: () => boolean, save: () => void): () => void {
  if (typeof document === "undefined") {
    save();
    return () => {};
  }
  const inPopup = (target: EventTarget | null) => target instanceof Element && !!target.closest("[data-popup]");
  const onFocusIn = (event: FocusEvent) => {
    if (inPopup(event.target)) return;
    document.removeEventListener("focusin", onFocusIn);
    if (!hasFocus()) save();
  };
  const timer = setTimeout(() => {
    if (hasFocus()) return;
    if (inPopup(document.activeElement)) document.addEventListener("focusin", onFocusIn);
    else save();
  });
  return () => {
    clearTimeout(timer);
    document.removeEventListener("focusin", onFocusIn);
  };
}
