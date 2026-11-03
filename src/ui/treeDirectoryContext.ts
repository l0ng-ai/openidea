import { useLayoutEffect, type RefObject } from "react";
import { setContext } from "@/platform/context";
import { isVirtualUri } from "@/platform/virtualDocs";

let owner: HTMLElement | null = null;

/** Only the focused tree contributes its selected directory to actions. */
export function useTreeDirectoryContext(
  ref: RefObject<HTMLElement | null>,
  directory: string | null | undefined,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    const clear = () => {
      if (owner !== element) return;
      owner = null;
      setContext("focusedDirectory", undefined);
    };
    const publish = () => {
      if (document.activeElement !== element) return;
      owner = element;
      setContext("focusedDirectory", directory && !isVirtualUri(directory) ? directory : undefined);
    };
    element.addEventListener("focus", publish);
    element.addEventListener("blur", clear);
    publish();
    return () => {
      element.removeEventListener("focus", publish);
      element.removeEventListener("blur", clear);
      clear();
    };
  }, [ref, directory, enabled]);
}
