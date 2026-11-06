import { useLayoutEffect, useRef, type ChangeEvent } from "react";

/**
 * Rewrites what the user types or pastes into a text input as IntelliJ does for ref names,
 * keeping the caret where the typed character was. Use as
 * `<Input ref={ref} onChange={(e) => setValue(clean(e))} />`.
 */
export function useSanitizedField(sanitize?: (value: string) => string) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  const place = () => {
    if (caret.current === null) return;
    ref.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  };
  // A controlled input whose text was rewritten loses its caret on re-render.
  useLayoutEffect(place);

  const clean = (e: ChangeEvent<HTMLInputElement>): string => {
    const raw = e.target.value;
    const value = sanitize ? sanitize(raw) : raw;
    if (value !== raw) {
      const at = e.target.selectionStart ?? raw.length;
      caret.current = sanitize ? sanitize(raw.slice(0, at)).length : at;
      // Nothing re-renders when the rewrite equals the current state (a dropped character), and
      // React then puts the caret at the end once this handler returns: a microtask runs after that.
      queueMicrotask(place);
    }
    return value;
  };

  return { ref, clean };
}
