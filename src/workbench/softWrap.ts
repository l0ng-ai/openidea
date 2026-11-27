/** Soft-wrap action targets outside the regular editor, retained while its menus are open. */
import { getContext, setContext } from "@/platform/context";

interface SoftWrapSurface {
  enabled(): boolean;
  toggle(): void;
}

let focused: SoftWrapSurface | null = null;

export function focusedSoftWrapSurface(): SoftWrapSurface | null {
  return focused;
}

export function registerSoftWrapSurface(host: HTMLElement, surface: SoftWrapSurface): () => void {
  const focus = (target: Element | null) => {
    if (target && host.contains(target)) {
      focused = surface;
      setContext("softWrapSurfaceFocus", true);
    } else if (
      focused === surface &&
      !getContext().popupOpen &&
      !target?.closest('[role="menu"], [role="menubar"], [aria-haspopup="menu"]')
    ) {
      focused = null;
      setContext("softWrapSurfaceFocus", false);
    }
  };
  const onFocus = (event: FocusEvent) => focus(event.target instanceof Element ? event.target : null);
  document.addEventListener("focusin", onFocus);
  focus(document.activeElement);
  return () => {
    document.removeEventListener("focusin", onFocus);
    if (focused === surface) {
      focused = null;
      setContext("softWrapSurfaceFocus", false);
    }
  };
}
