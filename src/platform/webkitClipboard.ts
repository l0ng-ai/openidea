/** WebKitGTK 2.54 can dispatch copy/cut twice for one keydown with a collapsed selection. */
export function installWebKitClipboardGuard(): () => void {
  let pending: { editor: Element; keydown: KeyboardEvent; seen: Set<string> } | null = null;
  const reset = () => {
    pending = null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const editor = event.target instanceof Element ? event.target.closest(".cm-content") : null;
    pending = editor ? { editor, keydown: event, seen: new Set() } : null;
  };
  const onClipboard = (event: Event) => {
    if (!pending || !(event.target instanceof Element) || event.target.closest(".cm-content") !== pending.editor)
      return;
    // Actions that already handled the key may intentionally run several clipboard commands (macros).
    if (pending.seen.size === 0 && pending.keydown.defaultPrevented) return;
    if (pending.seen.has(event.type)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else {
      pending.seen.add(event.type);
      // The native command can report failure after CodeMirror handles it. Stop its keypress fallback too.
      pending.keydown.preventDefault();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", reset, true);
  window.addEventListener("pointerdown", reset, true);
  window.addEventListener("blur", reset, true);
  window.addEventListener("copy", onClipboard, true);
  window.addEventListener("cut", onClipboard, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", reset, true);
    window.removeEventListener("pointerdown", reset, true);
    window.removeEventListener("blur", reset, true);
    window.removeEventListener("copy", onClipboard, true);
    window.removeEventListener("cut", onClipboard, true);
  };
}

/**
 * WebKitGTK pastes the primary selection on a middle-button release into the focused editable,
 * wherever the release lands: a middle click that closes a tab or hits any other control pasted
 * into the editor. Only a release over editable content pastes, as in native GTK apps.
 */
export function installMiddleClickPasteGuard(target: Window = window): () => void {
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 1) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault();
  };
  target.addEventListener("mouseup", onMouseUp, true);
  return () => target.removeEventListener("mouseup", onMouseUp, true);
}
