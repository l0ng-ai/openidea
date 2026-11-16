/**
 * The drag handle on the conversation side of a task's Changes pane. The width applies to
 * every task and is remembered across sessions.
 */
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { lockDragCursor } from "@/ui";
import { tx } from "@/platform/i18n";
import { clampChangesWidth, setChangesOptions, useChangesOptions } from "./changesOptions";
import styles from "./Session.module.css";

/** CSS custom property read by `.withChanges` in Session.module.css. */
const WIDTH_VAR = "--agent-changes-width";
/** Keep in step with the conversation's minimum in `.withChanges`. */
const MIN_CONVERSATION = 240;
const KEY_STEP = 16;

/** Style for the session that holds the pane. */
export function useChangesWidthStyle(): CSSProperties | undefined {
  const width = useChangesOptions((s) => s.width);
  return width == null ? undefined : ({ [WIDTH_VAR]: `${width}px` } as CSSProperties);
}

/** Pane width for `px`, leaving the conversation its minimum in `session`. */
function fit(px: number, session: HTMLElement) {
  return Math.min(clampChangesWidth(px), Math.max(0, session.clientWidth - MIN_CONVERSATION));
}

/** Render as the first child of the pane. */
export function ChangesResizer() {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const pane = handle.parentElement;
    const session = pane?.parentElement;
    if (e.button !== 0 || !pane || !session) return;
    // No focus ring or text selection from a mouse drag.
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = pane.getBoundingClientRect().width;
    const origin = e.clientX;
    const previous = session.style.getPropertyValue(WIDTH_VAR);
    const releaseCursor = lockDragCursor("ew-resize");
    let next: number | null = null;
    // Only this session follows the pointer; every task takes the new width on release.
    const move = (ev: globalThis.PointerEvent) => {
      if (!(ev.buttons & 1)) return end();
      next = fit(start + origin - ev.clientX, session);
      session.style.setProperty(WIDTH_VAR, `${next}px`);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      releaseCursor();
      if (next != null) setChangesOptions({ width: clampChangesWidth(next) });
      else if (previous) session.style.setProperty(WIDTH_VAR, previous);
      else session.style.removeProperty(WIDTH_VAR);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    const pane = e.currentTarget.parentElement;
    const session = pane?.parentElement;
    if (!dir || !pane || !session) return;
    e.preventDefault();
    setChangesOptions({
      width: clampChangesWidth(fit(pane.getBoundingClientRect().width + dir * KEY_STEP, session)),
    });
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={tx("Resize changes")}
      tabIndex={0}
      className={styles.changesResizer}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
