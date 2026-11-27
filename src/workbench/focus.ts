/** Focus routing between tool windows and the editor area. */
import { setContext, useContextKeys } from "@/platform/context";
import { syncFocusScope } from "@/ui/focusScope";
import { maybeEditorService } from "./contributions";

export const EDITOR_AREA_SELECTOR = "[data-editor-area]";

let activeTracker: ((el: Element | null) => void) | null = null;

/** Reports that focus entered `el` (e.g. a sandboxed plugin iframe that does not bubble `focusin`). */
export function notifyFocusElement(el: Element | null) {
  syncFocusScope(el);
  activeTracker?.(el);
}

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
  // Another editor takes the DOM selection itself; a hidden (detached) editor has none left.
  // Dropping it would only lay out the window once more while switching editors.
  if (!editor.isConnected || (e.relatedTarget instanceof Element && e.relatedTarget.matches(".cm-content"))) return;
  const selection = document.getSelection();
  if (selection?.anchorNode && editor.contains(selection.anchorNode)) selection.removeAllRanges();
}

/**
 * Tracks which workbench part holds focus and publishes `toolWindowFocus`,
 * `activeToolWindow` and `editorAreaFocus`. Returns an uninstaller.
 */
export function installFocusTracking(onToolWindowFocus: (id: string | null, editor: boolean) => void): () => void {
  let lastEl: Element | null = null;
  const handleFocus = (el: Element | null) => {
    if (el && el === lastEl && el instanceof HTMLIFrameElement) return;
    lastEl = el;
    const tw = el?.closest?.("[data-toolwindow]");
    const editor = !!el?.closest?.(EDITOR_AREA_SELECTOR);
    onToolWindowFocus(tw?.getAttribute("data-toolwindow") ?? null, editor);
    setContext("editorAreaFocus", editor);
  };
  activeTracker = handleFocus;
  const onFocusIn = (e: FocusEvent) => handleFocus(e.target as Element | null);
  const checkIframeFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && document.hasFocus()) handleFocus(active);
  };
  const onWindowBlur = () => {
    checkIframeFocus();
    queueMicrotask(checkIframeFocus);
  };
  const onFocusOut = (e: FocusEvent) => {
    dropEditorCaret(e);
    if (e.relatedTarget) return;
    // Focus left to nowhere (window blur keeps document.activeElement) or into an iframe.
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && document.hasFocus()) {
        handleFocus(active);
        return;
      }
      if (active && active !== document.body) return;
      lastEl = null;
      onToolWindowFocus(null, false);
      setContext("editorAreaFocus", false);
    });
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("blur", onWindowBlur);
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
    if (activeTracker === handleFocus) activeTracker = null;
    clearTimeout(refocus);
    unsubPopups();
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("blur", onWindowBlur);
  };
}
