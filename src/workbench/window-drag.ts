import { invoke } from "@tauri-apps/api/core";
import { commands } from "@/platform/ipc";
import { guessOs } from "@/platform/platformInfo";

/**
 * Title bar drag on macOS, replacing Tauri's injected `data-tauri-drag-region` script there.
 * That script starts the native drag on any `mousedown`, but WebKit can deliver a tap's `mousedown`
 * after the button is already up; AppKit then drags the window until the next click. Here the drag
 * starts only while the button is down (`buttons` here, and again natively in `window_start_drag`).
 * Windows and Linux keep the Tauri attribute.
 */
const REGION = "data-window-drag-region";

/** Attribute that makes an element a title bar drag region on this OS. */
export const windowDragRegion: Record<string, string> =
  guessOs() === "macos" ? { [REGION]: "" } : { "data-tauri-drag-region": "" };

const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);

function isClickable(el: HTMLElement) {
  const editable = el.getAttribute("contenteditable");
  const tabindex = el.getAttribute("tabindex");
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (editable !== null && editable !== "false") ||
    (tabindex !== null && tabindex !== "-1") ||
    INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")
  );
}

/** Same rules as Tauri's script: a bare attribute counts only for direct clicks, `deep` for the subtree. */
function isDragRegion(path: EventTarget[]) {
  for (const el of path) {
    if (!(el instanceof HTMLElement)) continue;
    const attr = el.getAttribute(REGION);
    if (attr === null) {
      if (isClickable(el)) return false;
      continue;
    }
    if (attr === "false") return false;
    if (attr === "deep") return true;
    return el === path[0];
  }
  return false;
}

interface Deps {
  enabled?: boolean;
  start?: () => unknown;
  toggleMaximize?: () => unknown;
}

/** Installs the handlers on macOS (no-op elsewhere); returns the uninstall function. */
export function installWindowDrag({
  enabled = guessOs() === "macos",
  start = () => commands.windowStartDrag(),
  toggleMaximize = () => invoke("plugin:window|internal_toggle_maximize"),
}: Deps = {}): () => void {
  if (!enabled) return () => {};
  let down = { x: 0, y: 0 };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || (e.detail !== 1 && e.detail !== 2) || !isDragRegion(e.composedPath())) return;
    // Zoom happens on mouseup, as in AppKit, so moving away cancels it.
    if (e.detail === 2) {
      down = { x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault(); // no text cursor
    e.stopImmediatePropagation();
    // A tap's mousedown arrives with the button already released: nothing to drag.
    if (e.buttons & 1) void start();
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0 || e.detail !== 2 || e.clientX !== down.x || e.clientY !== down.y) return;
    if (isDragRegion(e.composedPath())) void toggleMaximize();
  };

  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  return () => {
    document.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mouseup", onMouseUp);
  };
}
