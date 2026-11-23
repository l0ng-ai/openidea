import { create } from "zustand";
import { setContext } from "./context";

/**
 * What the window runs on: `desktop` (mouse or trackpad), or a touch screen as a
 * `tablet` or a `phone`. Read once at boot and kept current as the window resizes
 * or the primary pointer changes (an iPad gaining a trackpad).
 *
 * CSS reads it from `:root[data-form-factor]` and `:root[data-touch]`; `when`
 * clauses from the `formFactor` and `touch` context keys.
 */
export type FormFactor = "desktop" | "tablet" | "phone";

export interface FormFactorState {
  formFactor: FormFactor;
  /** The primary pointer is a finger: larger hit targets, long press for context menus. */
  touch: boolean;
}

/** Narrower than this, or shorter (a phone held sideways), a touch window is a phone. */
export const PHONE_MAX_WIDTH = 600;
export const PHONE_MAX_HEIGHT = 500;

export function classifyFormFactor(coarsePointer: boolean, width: number, height: number): FormFactorState {
  if (!coarsePointer) return { formFactor: "desktop", touch: false };
  const phone = width < PHONE_MAX_WIDTH || height < PHONE_MAX_HEIGHT;
  return { formFactor: phone ? "phone" : "tablet", touch: true };
}

export const useFormFactor = create<FormFactorState>(() => ({
  formFactor: "desktop",
  touch: false,
}));

const COARSE_POINTER = "(pointer: coarse)";

/** Detects the form factor now and on every change, mirroring it on `root` and the context keys. */
export function installFormFactor(win: Window = window, root: HTMLElement = win.document.documentElement): () => void {
  const coarse = win.matchMedia(COARSE_POINTER);
  const update = () => {
    const next = classifyFormFactor(coarse.matches, win.innerWidth, win.innerHeight);
    const prev = useFormFactor.getState();
    if (prev.formFactor !== next.formFactor || prev.touch !== next.touch) useFormFactor.setState(next, true);
    root.dataset.formFactor = next.formFactor;
    root.toggleAttribute("data-touch", next.touch);
    setContext("formFactor", next.formFactor);
    setContext("touch", next.touch);
  };
  update();
  coarse.addEventListener("change", update);
  win.addEventListener("resize", update);
  return () => {
    coarse.removeEventListener("change", update);
    win.removeEventListener("resize", update);
  };
}
