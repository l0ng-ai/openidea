/** Optional sibling reordering using the same pointer transport as editor tabs. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { registerDropTarget, startPointerDrag } from "./pointerDrag";

export interface TreeReorder<T> {
  canMove(source: T, target: T): boolean;
  move(source: T, target: T, position: "before" | "after"): void;
}

interface ReorderRow<T> {
  node: T;
  key: string;
  parentKey: string | null;
  loading?: boolean;
}

export function useTreeReorder<T>(
  container: RefObject<HTMLDivElement | null>,
  rows: readonly ReorderRow<T>[],
  reorder: TreeReorder<T> | undefined,
) {
  const type = `application/x-openidea-tree-${useId()}`;
  const latest = useRef({ rows, reorder });
  useLayoutEffect(() => {
    latest.current = { rows, reorder };
  });
  const cancel = useRef<(() => void) | undefined>(undefined);
  const suppressActivation = useRef(false);
  const [drop, setDrop] = useState<{ key: string; position: "before" | "after" } | null>(null);
  const enabled = !!reorder;

  useEffect(() => {
    const el = container.current;
    if (!el || !enabled) return;
    let frame = 0;
    let pointer: { key: string; x: number; y: number } | null = null;
    const targetAt = (key: string, x: number, y: number) => {
      const rowEl = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row]");
      if (!rowEl || !el.contains(rowEl)) return null;
      const { rows, reorder } = latest.current;
      const source = rows.find((r) => r.key === key);
      const target = rows[Number(rowEl.dataset.row)];
      if (
        !source ||
        !target ||
        source.loading ||
        target.loading ||
        source.key === target.key ||
        source.parentKey !== target.parentKey ||
        !reorder?.canMove(source.node, target.node)
      )
        return null;
      const rect = rowEl.getBoundingClientRect();
      const position = y < rect.top + rect.height / 2 ? "before" : "after";
      return { source, target, position } as const;
    };
    const update = () => {
      const target = pointer && targetAt(pointer.key, pointer.x, pointer.y);
      setDrop(target ? { key: target.target.key, position: target.position } : null);
    };
    const scroll = () => {
      frame = 0;
      if (!pointer) return;
      const rect = el.getBoundingClientRect();
      const delta = pointer.y < rect.top + 24 ? -8 : pointer.y > rect.bottom - 24 ? 8 : 0;
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, before + delta));
      if (el.scrollTop !== before) {
        update();
        frame = requestAnimationFrame(scroll);
      }
    };
    const leave = () => {
      pointer = null;
      cancelAnimationFrame(frame);
      frame = 0;
      setDrop(null);
    };
    const unregister = registerDropTarget(el, {
      accepts: (candidate) => candidate === type,
      over: (data, x, y) => {
        pointer = { key: data.payload, x, y };
        update();
        if (!frame) frame = requestAnimationFrame(scroll);
      },
      leave,
      drop: (data, x, y) => {
        const target = targetAt(data.payload, x, y);
        leave();
        if (target) latest.current.reorder?.move(target.source.node, target.target.node, target.position);
      },
    });
    return () => {
      cancel.current?.();
      leave();
      unregister();
    };
  }, [container, enabled, type]);

  const start = (e: PointerEvent<HTMLElement>, row: ReorderRow<T>) => {
    suppressActivation.current = false;
    if (
      !reorder ||
      e.button !== 0 ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      (e.target as Element).closest("[data-tree-toggle], button, input, a, textarea, select")
    )
      return;
    if (
      !rows.some(
        (target) =>
          target.key !== row.key &&
          target.parentKey === row.parentKey &&
          !target.loading &&
          reorder.canMove(row.node, target.node),
      )
    )
      return;
    cancel.current?.();
    cancel.current = startPointerDrag(
      e,
      e.currentTarget,
      { type, payload: row.key },
      {
        onEnd: (dragged) => {
          suppressActivation.current = dragged;
          cancel.current = undefined;
        },
      },
    );
  };
  return { drop, start, suppressActivation };
}
