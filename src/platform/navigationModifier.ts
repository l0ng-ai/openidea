/**
 * The navigation modifier (⌘ on macOS, Ctrl elsewhere) as a live, window-wide
 * state: ⌘/Ctrl-hover shows the navigation link and its brief info, and every
 * plain hover popup (quick documentation, problems, debugger values) yields to
 * it. Tracked on the window so an editor sees the key even when it isn't focused.
 */
import { hasPrimaryModifier, isMacHost } from "./keymap";

type ModifierEvent = Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** ⌘/Ctrl alone: no ⌥/⇧ (other gestures) and not the other platform's Ctrl/⌘. */
export function isNavigationGesture(e: ModifierEvent): boolean {
  return hasPrimaryModifier(e) && !e.altKey && !e.shiftKey && !(isMacHost() ? e.ctrlKey : e.metaKey);
}

let held = false;
let pointer: Element | null = null;
const listeners = new Set<(held: boolean) => void>();
let installed: (() => void) | null = null;

function setHeld(value: boolean) {
  if (held === value) return;
  held = value;
  for (const fn of [...listeners]) fn(value);
}

function install() {
  if (installed || typeof window === "undefined") return;
  const onKey = (e: KeyboardEvent) => setHeld(isNavigationGesture(e));
  // Also from pointer events: a key released outside the window never reports its keyup.
  const onMouse = (e: MouseEvent) => {
    pointer = e.target instanceof Element ? e.target : null;
    setHeld(isNavigationGesture(e));
  };
  const onBlur = () => setHeld(false);
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("keydown", onKey, opts);
  window.addEventListener("keyup", onKey, opts);
  window.addEventListener("mousemove", onMouse, opts);
  window.addEventListener("mousedown", onMouse, opts);
  window.addEventListener("blur", onBlur);
  installed = () => {
    window.removeEventListener("keydown", onKey, opts);
    window.removeEventListener("keyup", onKey, opts);
    window.removeEventListener("mousemove", onMouse, opts);
    window.removeEventListener("mousedown", onMouse, opts);
    window.removeEventListener("blur", onBlur);
    installed = null;
  };
}

/** Whether ⌘ (macOS) / Ctrl is held on its own right now. */
export function navigationModifierHeld(): boolean {
  install();
  return held;
}

/** Element under the pointer at the last mouse move (null before any). */
export function pointerTarget(): Element | null {
  install();
  return pointer;
}

/** Called with the new state whenever the navigation modifier is pressed or released. */
export function onNavigationModifier(fn: (held: boolean) => void): () => void {
  install();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests: forget the tracked state and listeners. */
export function resetNavigationModifier() {
  installed?.();
  held = false;
  pointer = null;
  listeners.clear();
}
