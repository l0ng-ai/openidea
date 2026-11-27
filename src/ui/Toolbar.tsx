import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { useGivenTx } from "@/platform/i18n";

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  "aria-label": string;
  orientation?: "horizontal" | "vertical";
}

const ITEMS = "button, input, select, textarea, a[href], [tabindex]";
/** Controls whose tabindex a toolbar wrote, as opposed to an owner's own `-1` (kept across remounts). */
const managed = new WeakSet<Element>();

/**
 * A toolbar that is one Tab stop (WAI-ARIA toolbar): the arrow keys, Home and End move
 * between its controls, and Tab enters at the control used last. IDEA's toolbar buttons
 * aren't Tab stops at all; this keeps them reachable from the keyboard.
 *
 * Roving works on the DOM, so the controls need nothing: a control that sets its own
 * `tabIndex={-1}` stays out, and controls added, removed, enabled or disabled later are
 * picked up.
 */
export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(function Toolbar(
  { orientation = "horizontal", "aria-label": ariaLabel, children, ...rest },
  ref,
) {
  const tx = useGivenTx();
  const root = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => root.current!);

  useLayoutEffect(() => {
    const el = root.current!;
    let current: Element | null = null;
    const candidates = () =>
      [...el.querySelectorAll<HTMLElement>(ITEMS)].filter(
        (item) => managed.has(item) || item.getAttribute("tabindex") !== "-1",
      );
    const items = () => candidates().filter((item) => !(item as HTMLButtonElement).disabled);
    const sync = () => {
      const all = candidates();
      const enabled = all.filter((item) => !(item as HTMLButtonElement).disabled);
      if (!current || !enabled.includes(current as HTMLElement)) current = enabled[0] ?? null;
      for (const item of all) {
        const index = item === current ? "0" : "-1";
        if (item.getAttribute("tabindex") !== index) item.setAttribute("tabindex", index);
        managed.add(item);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Element) || !items().includes(e.target as HTMLElement)) return;
      current = e.target;
      sync();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement;
      const all = items();
      const index = all.indexOf(target);
      if (index < 0) return;
      const vertical = orientation === "vertical";
      // Text fields keep their caret keys.
      const text = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      let next: number;
      if (e.key === (vertical ? "ArrowDown" : "ArrowRight") && !text) next = index + 1;
      else if (e.key === (vertical ? "ArrowUp" : "ArrowLeft") && !text) next = index - 1;
      else if (e.key === "Home" && !text) next = 0;
      else if (e.key === "End" && !text) next = all.length - 1;
      else return;
      e.preventDefault();
      all[(next + all.length) % all.length]!.focus();
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [orientation]);

  return (
    <div ref={root} role="toolbar" aria-orientation={orientation} aria-label={tx(ariaLabel)} {...rest}>
      {children}
    </div>
  );
});
