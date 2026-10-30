/**
 * Pointer-driven drag & drop between components. HTML5 drag and drop can't be
 * used: with the window's native file drop enabled, the webview never sees
 * dragover / drop for drags that start inside it. Sources start a drag with
 * `startPointerDrag` (or drive a `DragSession` themselves); targets register
 * an element with `registerDropTarget` and are told about drags over it.
 */
import styles from "./pointerDrag.module.css";

/** What is dragged: `type` is matched by targets (e.g. `application/x-openidea-editor-tab`). */
export interface DragData {
  type: string;
  payload: string;
}

/** Project files dragged from the Project view: `payload` is the paths joined by `\n`. */
export const FILES_DRAG = "application/x-openidea-files";

export interface DropTarget {
  accepts(type: string): boolean;
  /** The pointer moved over the target. */
  over(data: DragData, x: number, y: number): void;
  /** The pointer left the target, or the drag ended elsewhere / was cancelled. */
  leave(): void;
  drop(data: DragData, x: number, y: number): void;
}

const targets = new Map<Element, DropTarget>();

export function registerDropTarget(el: Element, target: DropTarget): () => void {
  targets.set(el, target);
  return () => {
    if (targets.get(el) === target) targets.delete(el);
  };
}

/** The innermost registered target under (x, y) accepting `type`. */
function targetAt(type: string, x: number, y: number): DropTarget | null {
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    const t = targets.get(el);
    if (t?.accepts(type)) return t;
  }
  return null;
}

export interface DragSession {
  /** Updates hover feedback; true when a target under (x, y) accepts the drag. */
  move(x: number, y: number): boolean;
  /** Drops on the target under (x, y); false when there is none. */
  drop(x: number, y: number): boolean;
  cancel(): void;
}

/**
 * Whether client point (`x`, `y`) is outside `rect` (the window's viewport):
 * a tab drag released there detaches into a new window instead of reordering.
 * Pure, so detach tests don't need a DOM.
 */
export function isOutsideWindow(
  rect: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom;
}

export function dragSession(data: DragData): DragSession {
  let current: DropTarget | null = null;
  const enter = (t: DropTarget | null) => {
    if (t === current) return;
    current?.leave();
    current = t;
  };
  return {
    move(x, y) {
      enter(targetAt(data.type, x, y));
      current?.over(data, x, y);
      return !!current;
    },
    drop(x, y) {
      const t = targetAt(data.type, x, y);
      enter(null);
      t?.drop(data, x, y);
      return !!t;
    },
    cancel: () => enter(null),
  };
}

/** Movement before a press becomes a drag, px. */
const DRAG_THRESHOLD = 4;

/** Settings › Appearance › "Drag-and-drop with Alt pressed only" for tabs and stripe buttons. */
let requiresAlt = () => false;
export function setDragRequiresAlt(fn: () => boolean) {
  requiresAlt = fn;
}
export const dragRequiresAlt = () => requiresAlt();

export interface PointerDrop {
  x: number;
  y: number;
  /** True when a registered target accepted the drop. */
  accepted: boolean;
}

/**
 * Starts a drag from a primary-button press on `source` once the pointer moved
 * past the threshold; a ghost copy of `source` follows the pointer. Escape
 * cancels. `onEnd` gets whether the drag happened (to swallow the click) and,
 * when it did, where the pointer was released and whether a target accepted it
 * (an editor tab released outside the window detaches into a new window).
 */
export function startPointerDrag(
  e: { button: number; clientX: number; clientY: number; altKey: boolean },
  source: HTMLElement,
  data: DragData,
  opts: { onStart?: () => void; onEnd?: (dragged: boolean, drop?: PointerDrop) => void } = {},
) {
  if (e.button !== 0 || (requiresAlt() && !e.altKey)) return;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const session = dragSession(data);
  const onMove = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = source.getBoundingClientRect();
      ghost = source.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("id");
      ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      ghost.classList.add(styles.ghost!);
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      document.documentElement.classList.add(styles.dragging!);
      opts.onStart?.();
    }
    ghost.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
    ghost.classList.toggle(styles.noTarget!, !session.move(ev.clientX, ev.clientY));
  };
  const onUp = (ev: PointerEvent) => {
    const dragged = !!ghost;
    cleanup();
    if (!dragged) {
      opts.onEnd?.(false);
      return;
    }
    const accepted = session.drop(ev.clientX, ev.clientY);
    opts.onEnd?.(true, { x: ev.clientX, y: ev.clientY, accepted });
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    session.cancel();
    cleanup();
    opts.onEnd?.(true);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    ghost?.remove();
    document.documentElement.classList.remove(styles.dragging!);
  };
  const onCancel = () => {
    session.cancel();
    const dragged = !!ghost;
    cleanup();
    opts.onEnd?.(dragged);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
