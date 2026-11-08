/** Focus routing between tool windows and the editor area. */
import { setContext, useContextKeys } from "@/platform/context";
import { maybeEditorService } from "./contributions";

export const EDITOR_AREA_SELECTOR = "[data-editor-area]";

/** Moves focus to the active editor (or the editor area when none is open). */
export function focusEditor() {
  if (typeof document !== "undefined" && document.querySelector(EDITOR_AREA_SELECTOR)?.closest("[hidden]")) {
    // Restoring the layout commits the editor's visibility on the next render.
    requestAnimationFrame(focusEditorNow);
    return;
  }
  focusEditorNow();
}

function focusEditorNow() {
  const service = maybeEditorService();
  if (service?.focus) {
    service.focus();
    return;
  }
  if (typeof document === "undefined") return;
  const area = document.querySelector<HTMLElement>(EDITOR_AREA_SELECTOR);
  const target = area?.querySelector<HTMLElement>(".cm-content, [data-editor-focus]") ?? area;
  target?.focus({ preventScroll: true });
}

/**
 * WebKit keeps the DOM caret of an editor that loses focus during a mouse press, as when a
 * right-click opens the context menu. The editor redraws its lines while unfocused, which moves
 * that caret to an unrelated line, and focusing the editor again scrolls to it even with
 * `preventScroll`. Without it, focusing puts the caret at the start of the content without
 * scrolling and CodeMirror restores its own selection.
 */
function dropEditorCaret(e: FocusEvent) {
  const editor = e.target;
  if (!(editor instanceof HTMLElement) || !editor.matches('.cm-content[contenteditable="true"]')) return;
  // The window lost focus and keeps the editor focused for its return.
  if (document.activeElement === editor) return;
  if (e.relatedTarget instanceof Node && editor.contains(e.relatedTarget)) return;
  const selection = document.getSelection();
  if (selection?.anchorNode && editor.contains(selection.anchorNode)) selection.removeAllRanges();
}

/**
 * Tracks which workbench part holds focus and publishes `toolWindowFocus`,
 * `activeToolWindow` and `editorAreaFocus`. Returns an uninstaller.
 */
export function installFocusTracking(onToolWindowFocus: (id: string | null) => void): () => void {
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as Element | null;
    const tw = el?.closest?.("[data-toolwindow]");
    onToolWindowFocus(tw?.getAttribute("data-toolwindow") ?? null);
    setContext("editorAreaFocus", !!el?.closest?.(EDITOR_AREA_SELECTOR));
  };
  const onFocusOut = (e: FocusEvent) => {
    dropEditorCaret(e);
    if (e.relatedTarget) return;
    // Focus left to nowhere (window blur keeps document.activeElement).
    queueMicrotask(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      onToolWindowFocus(null);
      setContext("editorAreaFocus", false);
    });
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  // IDEA: closing the last popup / menu / dialog never leaves focus nowhere.
  let popupOpen = !!useContextKeys.getState().popupOpen;
  let refocus: ReturnType<typeof setTimeout> | undefined;
  const unsubPopups = useContextKeys.subscribe((ctx) => {
    const open = !!ctx.popupOpen;
    if (open === popupOpen) return;
    popupOpen = open;
    clearTimeout(refocus);
    if (open) return;
    refocus = setTimeout(() => {
      if (!popupOpen && (!document.activeElement || document.activeElement === document.body)) focusEditor();
    });
  });
  return () => {
    clearTimeout(refocus);
    unsubPopups();
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
}
