import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

/**
 * The selected rows. A mouse selection keeps every row between its ends mounted, so the
 * browser's selection (and copying it) holds the text between them. A caret (a collapsed
 * selection) and a keyboard selection keep only their ends: ⇧⌃Home over a long output would
 * otherwise mount every line, and the console copies a keyboard selection from its model.
 */
type SelectedRows = { start: number; end: number; dragging: boolean; ends: boolean; collapsed: boolean };

/** Keep the browser's selection endpoints, and the text between them, mounted. */
export function useConsoleSelection(host: RefObject<HTMLDivElement | null>, pauseFollow: () => void) {
  const pause = useEffectEvent(pauseFollow);
  const [selected, setSelected] = useState<SelectedRows | null>(null);
  /** The current selection was made with the keyboard (the caret), not the mouse. */
  const keyboard = useRef(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dragging = false;
    const indexOf = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest<HTMLElement>("[data-index]");
      return row && el.contains(row) ? Number(row.dataset.index) : null;
    };
    const update = () => {
      const selection = window.getSelection();
      const anchor = indexOf(selection?.anchorNode ?? null);
      const focus = indexOf(selection?.focusNode ?? null);
      const next: SelectedRows | null =
        selection && anchor !== null && focus !== null
          ? {
              start: Math.min(anchor, focus),
              end: Math.max(anchor, focus),
              dragging,
              ends: keyboard.current && !dragging,
              collapsed: selection.isCollapsed && !dragging,
            }
          : null;
      setSelected((prev) =>
        prev?.start === next?.start &&
        prev?.end === next?.end &&
        prev?.dragging === next?.dragging &&
        prev?.ends === next?.ends &&
        prev?.collapsed === next?.collapsed
          ? prev
          : next,
      );
      if (next && !selection!.isCollapsed) pause();
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 0) return;
      keyboard.current = false;
      const index = indexOf(event.target as Node);
      if (index === null) return;
      dragging = true;
      // Pin the anchor before a scroll can recycle it, even before selectionchange fires.
      setSelected({ start: index, end: index, dragging: true, ends: false, collapsed: false });
      pause();
    };
    const up = () => {
      dragging = false;
      update();
    };
    el.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    document.addEventListener("selectionchange", update);
    return () => {
      el.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("selectionchange", update);
    };
  }, [host]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      const visible = defaultRangeExtractor(range);
      if (!selected || !visible.length) return visible;
      const indices = new Set(visible);
      if (selected.collapsed || selected.ends) {
        for (const i of [selected.start, selected.end]) if (i < range.count) indices.add(i);
        return [...indices].sort((a, b) => a - b);
      }
      // During a drag, scrolling must also render every line up to the pointer.
      const start = Math.max(0, selected.dragging ? Math.min(selected.start, visible[0]!) : selected.start);
      const end = Math.min(
        range.count - 1,
        selected.dragging ? Math.max(selected.end, visible[visible.length - 1]!) : selected.end,
      );
      for (let i = start; i <= end; i++) indices.add(i);
      return [...indices].sort((a, b) => a - b);
    },
    [selected],
  );
  /** Marks the selection about to be set as the caret's, before its selectionchange. */
  const markKeyboardSelection = useCallback(() => {
    keyboard.current = true;
  }, []);
  /** Whether the live selection was made with the keyboard. */
  const keyboardSelection = useCallback(() => keyboard.current, []);
  return {
    rangeExtractor,
    selecting: selected !== null && !selected.collapsed,
    markKeyboardSelection,
    keyboardSelection,
  };
}
