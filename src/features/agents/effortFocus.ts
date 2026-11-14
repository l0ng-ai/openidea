/** Effort actions belong to the focused, visible agent surface, never the last-used task. */
import { useLayoutEffect, type RefObject } from "react";
import { setContext } from "@/platform/context";

let focused: { cycle: () => void } | null = null;

export function cycleFocusedEffort() {
  focused?.cycle();
}

export function useEffortFocus(
  root: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  cycle: (() => void) | undefined,
) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !enabled || !cycle) return;
    const target = { cycle };
    const focus = () => {
      focused = target;
      setContext("agentEffortAvailable", true);
    };
    const clear = () => {
      if (focused !== target) return;
      focused = null;
      setContext("agentEffortAvailable", false);
    };
    const blur = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null)) clear();
    };
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    if (element.contains(document.activeElement)) focus();
    return () => {
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      clear();
    };
  }, [root, enabled, cycle]);
}
