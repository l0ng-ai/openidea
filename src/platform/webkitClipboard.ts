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
