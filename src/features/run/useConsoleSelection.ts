import { useCallback, useEffect, useEffectEvent, useState, type RefObject } from "react";
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

type SelectedRows = { start: number; end: number; dragging: boolean };

/** Keep the browser's selection endpoints, and the text between them, mounted. */
export function useConsoleSelection(host: RefObject<HTMLDivElement | null>, pauseFollow: () => void) {
  const pause = useEffectEvent(pauseFollow);
  const [selected, setSelected] = useState<SelectedRows | null>(null);

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
      const next =
        selection && (!selection.isCollapsed || dragging) && anchor !== null && focus !== null
          ? { start: Math.min(anchor, focus), end: Math.max(anchor, focus), dragging }
          : null;
      setSelected((prev) =>
        prev?.start === next?.start && prev?.end === next?.end && prev?.dragging === next?.dragging ? prev : next,
      );
      if (next && !selection!.isCollapsed) pause();
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const index = indexOf(event.target as Node);
      if (index === null) return;
      dragging = true;
      // Pin the anchor before a scroll can recycle it, even before selectionchange fires.
      setSelected({ start: index, end: index, dragging: true });
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
      // During a drag, scrolling must also render every line up to the pointer.
      const start = Math.max(0, selected.dragging ? Math.min(selected.start, visible[0]!) : selected.start);
      const end = Math.min(
        range.count - 1,
        selected.dragging ? Math.max(selected.end, visible[visible.length - 1]!) : selected.end,
      );
      const indices = new Set(visible);
      for (let i = start; i <= end; i++) indices.add(i);
      return [...indices].sort((a, b) => a - b);
    },
    [selected],
  );
  return { rangeExtractor, selecting: selected !== null };
}
