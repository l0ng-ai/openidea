/**
 * True while an input method is composing, including the key that ends it: WebKit sends the
 * Enter / Space that commits a candidate after `compositionend`, with `isComposing` already
 * false and keyCode 229, so a handler checking `isComposing` alone runs that Enter.
 */
export function isImeKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

function isPlainTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
  // xterm's hidden textarea has its own IME handling (features/terminal/imeInput.ts).
  return !target.closest(".xterm");
}

/**
 * Keeps IME keys away from every handler of an `<input>` / `<textarea>`. Each handler that
 * reacts to Enter, arrows or Escape must otherwise guard with {@link isImeKey} itself, and
 * the ones that forget run the key that picks a candidate (Replace, run a line, check out a
 * branch, commit a cell edit). Default actions are untouched, so the input method still works.
 */
export function installImeKeyGuard(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e) && isPlainTextField(e.target)) e.stopImmediatePropagation();
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}
