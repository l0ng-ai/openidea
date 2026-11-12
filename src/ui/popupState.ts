/**
 * Stack of open layers (popups, menus, dialogs, speed search). Only the
 * top-most layer reacts to Escape; clicks inside a layer above don't dismiss
 * the ones below. Publishes the `popupOpen` context key so global bindings
 * (e.g. Escape → focus editor) stand down while a layer owns the keyboard.
 */
import { setContext } from "@/platform/context";

interface Layer {
  id: number;
  el: () => HTMLElement | null;
  dismiss?: () => void;
}

const layers: Layer[] = [];
let seq = 0;
let anonymous = 0;

function publish() {
  setContext("popupOpen", layers.length + anonymous > 0);
}

export interface LayerHandle {
  readonly id: number;
  isTop(): boolean;
  /** True when `target` lies inside this layer or any layer stacked above it. */
  containsFromHere(target: Node): boolean;
  release(): void;
}

/** `dismiss` closes the layer when a modal dialog opens over it (see `dismissPopups`). */
export function openLayer(el: () => HTMLElement | null, dismiss?: () => void): LayerHandle {
  const layer: Layer = { id: ++seq, el, dismiss };
  layers.push(layer);
  publish();
  let released = false;
  return {
    id: layer.id,
    isTop: () => layers[layers.length - 1]?.id === layer.id,
    containsFromHere(target) {
      const idx = layers.findIndex((l) => l.id === layer.id);
      for (let i = Math.max(0, idx); i < layers.length; i++) if (layers[i]!.el()?.contains(target)) return true;
      return false;
    },
    release() {
      if (released) return;
      released = true;
      const i = layers.findIndex((l) => l.id === layer.id);
      if (i >= 0) layers.splice(i, 1);
      publish();
    },
  };
}

/**
 * Closes the popups open when a modal dialog opens, except `keep` (popups the dialog is rendered
 * inside): popups stack above dialogs, so one left open would cover it. IDEA cancels them too.
 */
export function dismissPopups(keep: ReadonlySet<number>): void {
  for (const layer of layers.slice()) if (layer.dismiss && !keep.has(layer.id)) layer.dismiss();
}

/** Marks a keyboard-owning UI without a DOM layer (e.g. inline speed search). */
export function acquirePopup(): () => void {
  anonymous++;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    anonymous = Math.max(0, anonymous - 1);
    publish();
  };
}

/**
 * Calls `fn` when the app window is deactivated (IDEA cancels popups then).
 * Focus moving into one of our own frames also blurs the window: ignored.
 */
export function onWindowDeactivate(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onBlur = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.hasFocus()) fn();
    }, 0);
  };
  window.addEventListener("blur", onBlur);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
  };
}

export function isPopupOpen(): boolean {
  return layers.length + anonymous > 0;
}

export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab focus cycling inside `root`. Returns true when it handled the key. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0);
  if (!items.length) return false;
  const first = items[0]!,
    last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
