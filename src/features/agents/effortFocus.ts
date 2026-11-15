/** Effort actions belong to the focused, visible agent surface, never the last-used task. */
import { useLayoutEffect, useState, type RefObject } from "react";
import type { AgentConfigOption } from "@/bindings";
import { setContext } from "@/platform/context";
import { nextValue } from "./composerModel";

let focused: { cycle: () => void } | null = null;

export function cycleFocusedEffort() {
  focused?.cycle();
}

export function useEffortFocus(
  root: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  config: readonly AgentConfigOption[],
  onChange: (id: string, value: string) => void,
) {
  const option = config.find((entry) => entry.category === "thought_level" && entry.values.length > 0);
  const [announced, setAnnounced] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !enabled || !option || option.values.length <= 1) return;
    const target = {
      cycle: () => {
        const value = nextValue(option, option.current);
        if (value === null) return;
        onChange(option.id, value);
        setAnnounced(true);
      },
    };
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
  }, [root, enabled, option, onChange]);
  return announced ? (option?.values.find((value) => value.value === option.current)?.name ?? null) : null;
}
