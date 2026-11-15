/**
 * Width limit of editor tabs placed left / right, as in IDEA: the column fits its
 * labels up to this limit, and dragging its inner edge sets the limit for every
 * editor group. Remembered across sessions.
 */
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { create } from "zustand";
import { lockDragCursor } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./EditorArea.module.css";

const KEY = "openidea.editor.sideTabsWidth";
const MIN_WIDTH = 80;
const MAX_WIDTH = 800;
const KEY_STEP = 16;
/** CSS custom property read by `.tabsVertical` in EditorArea.module.css. */
const LIMIT_VAR = "--side-tabs-limit";

function load(): number | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return typeof v === "number" && Number.isFinite(v) ? clamp(v) : null;
  } catch {
    return null;
  }
}

function clamp(px: number) {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)));
}

/** `null`: the default limit from the stylesheet. */
const useSideTabsWidth = create<{ width: number | null }>(() => ({ width: load() }));

function setSideTabsWidth(px: number) {
  const width = clamp(px);
  useSideTabsWidth.setState({ width });
  try {
    localStorage.setItem(KEY, JSON.stringify(width));
  } catch {
    // Storage unavailable: the width lasts for this session.
  }
}

/** Style for the editor pane that holds a vertical tab column. */
export function useSideTabsStyle(): CSSProperties | undefined {
  const width = useSideTabsWidth((s) => s.width);
  return width == null ? undefined : ({ [LIMIT_VAR]: `${width}px` } as CSSProperties);
}

/** The drag handle on the editor side of the tab column; render it right after the column. */
export function SideTabsResizer({ side }: { side: "left" | "right" }) {
  const sign = side === "left" ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const pane = handle.parentElement;
    const start = handle.previousElementSibling?.getBoundingClientRect().width;
    if (e.button !== 0 || !pane || start == null) return;
    // No focus ring or text selection from a mouse drag.
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const origin = e.clientX;
    const previous = pane.style.getPropertyValue(LIMIT_VAR);
    const releaseCursor = lockDragCursor("ew-resize");
    let next: number | null = null;
    // Only this pane follows the pointer; every group takes the new width on release.
    const move = (ev: globalThis.PointerEvent) => {
      if (!(ev.buttons & 1)) return end();
      next = clamp(start + sign * (ev.clientX - origin));
      pane.style.setProperty(LIMIT_VAR, `${next}px`);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      releaseCursor();
      if (next != null) setSideTabsWidth(next);
      else if (previous) pane.style.setProperty(LIMIT_VAR, previous);
      else pane.style.removeProperty(LIMIT_VAR);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const width = e.currentTarget.previousElementSibling?.getBoundingClientRect().width;
    if (!dir || width == null) return;
    e.preventDefault();
    setSideTabsWidth(width + sign * dir * KEY_STEP);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={tx("Resize editor tabs")}
      tabIndex={0}
      className={styles.sideTabsResizer}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
