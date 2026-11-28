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

/**
 * The text a composition commits, without the syllable spaces an IME displays when it commits
 * its raw letters (the commit is the composition text itself and plain ASCII): switching macOS
 * Pinyin to English mid-composition commits `ni hao` for `nihao`. The user never typed those
 * spaces: Space picks a candidate while composing. Candidate commits are returned unchanged.
 */
export function typedImeCommit(commit: string, composition: string): string {
  if (commit !== composition || !/^[\x20-\x7e]+$/.test(commit)) return commit;
  return commit.replaceAll(" ", "");
}
