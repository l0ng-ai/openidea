/**
 * Anchored popover: portal + flip/shift positioning, Escape / outside-click /
 * window-deactivation dismissal (top-most popup only for Escape), optional
 * focus trap and focus restore, optional resize from the right and bottom edges.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  autoUpdate,
  flip,
  offset as offsetMw,
  shift,
  size as sizeMw,
  useFloating,
  type Middleware,
  type Placement,
  type VirtualElement,
} from "@floating-ui/react-dom";
import { lockDragCursor } from "./dragCursor";
import { FOCUSABLE, onWindowDeactivate, openLayer, trapTab } from "./popupState";
import { tx } from "@/platform/i18n";
import styles from "./Popup.module.css";

/** Layer ids of the popups a component is rendered inside: a dialog opened there leaves them open. */
export const PopupAncestry = createContext<readonly RefObject<number | null>[]>([]);

export type PopupAnchor =
  | Element
  | VirtualElement
  | RefObject<Element | null>
  | { x: number; y: number }
  | "center"
  | null;

export interface PopupProps {
  open: boolean;
  onClose: (reason: "escape" | "outside" | "action") => void;
  anchor: PopupAnchor;
  placement?: Placement;
  offset?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  role?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  /** Keep Tab inside the popup. */
  trapFocus?: boolean;
  /** Focus on open: `true` = first `[data-autofocus]`/focusable/the popup itself; `false` = leave focus. */
  autoFocus?: boolean;
  restoreFocus?: boolean;
  closeOnOutsideClick?: boolean;
  /** Close (as "outside") when the app window loses focus, like IDEA popups (default true). */
  closeOnDeactivate?: boolean;
  /** Match the anchor's width (dropdowns). */
  matchWidth?: boolean;
  /** Limit an anchored popup to its anchor's width plus this many pixels. */
  maxWidthOverAnchor?: number;
  /** Plain surface without border/shadow styling. */
  unstyled?: boolean;
  /**
   * `both`: the right and bottom edges and their corner resize the popup (IDEA's resizable
   * popups); it keeps its anchored top-left corner. For a popup whose content doesn't scroll
   * the popup itself.
   */
  resizable?: "both";
  minWidth?: number;
  minHeight?: number;
  /** Size to open at, such as one remembered from `onResized`. While a size applies the popup has `data-resized`. */
  initialSize?: { w: number; h: number } | null;
  /** The size a resize ended at. */
  onResized?: (size: { w: number; h: number }) => void;
}

type ResizeEdge = "right" | "bottom" | "corner";
const EDGE_CURSOR = { right: "ew-resize", bottom: "ns-resize", corner: "nwse-resize" } as const;

const measureNaturalHeight: Middleware = {
  name: "measureNaturalHeight",
  fn({ elements, middlewareData }) {
    // Keep the new cap through internal flip/size restarts, not through the next update.
    if (middlewareData.measureNaturalHeight) return {};
    const scrollTop = elements.floating.scrollTop;
    const previousLimit = elements.floating.style.removeProperty("max-height");
    return { data: { scrollTop }, reset: previousLimit ? { rects: true } : undefined };
  },
};

function watchPopupSize(reference: Element | VirtualElement, floating: HTMLElement, update: () => void) {
  // Positioning writes the popup's size limits. Defer those writes outside the resize observer's delivery.
  let frame = 0;
  let placed = false;
  const stop = autoUpdate(reference, floating, () => {
    // The first placement runs at once, so the popup opens where it stays.
    if (!placed) {
      placed = true;
      update();
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  });
  return () => {
    stop();
    cancelAnimationFrame(frame);
  };
}

function toReference(anchor: PopupAnchor): Element | VirtualElement | null {
  if (!anchor || anchor === "center") return null;
  if ("current" in anchor) return anchor.current;
  if ("getBoundingClientRect" in anchor) return anchor;
  const { x, y } = anchor;
  return {
    getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }),
  };
}

export function Popup(props: PopupProps) {
  if (!props.open) return null;
  return <PopupInner {...props} />;
}

function PopupInner({
  onClose,
  anchor,
  placement = "bottom-start",
  offset = 4,
  children,
  className,
  style,
  role = "dialog",
  trapFocus = false,
  autoFocus = true,
  restoreFocus = true,
  closeOnOutsideClick = true,
  closeOnDeactivate = true,
  matchWidth = false,
  maxWidthOverAnchor,
  unstyled = false,
  resizable,
  minWidth = 200,
  minHeight = 120,
  initialSize,
  onResized,
  ...aria
}: PopupProps) {
  const centered = anchor === "center";
  const reference = toReference(anchor);
  const hasInlineMaxHeight = style?.maxHeight != null && style.maxHeight !== "";
  const middleware = useMemo(
    () => [
      offsetMw(offset),
      hasInlineMaxHeight ? null : measureNaturalHeight,
      flip({ padding: 6 }),
      shift({ padding: 6 }),
      sizeMw({
        padding: 6,
        apply({ rects, elements, availableHeight, availableWidth, middlewareData }) {
          const floatingStyle = elements.floating.style;
          const maxHeight = Math.max(120, availableHeight);
          if (!hasInlineMaxHeight && (rects.floating.height > maxHeight || floatingStyle.maxHeight)) {
            floatingStyle.maxHeight = `${maxHeight}px`;
            const scrollTop = middlewareData.measureNaturalHeight?.scrollTop;
            if (scrollTop) elements.floating.scrollTop = scrollTop;
          }
          const anchorLimit = maxWidthOverAnchor === undefined ? Infinity : rects.reference.width + maxWidthOverAnchor;
          const width = Math.max(0, Math.min(availableWidth, anchorLimit));
          floatingStyle.maxWidth = `${width}px`;
          if (matchWidth) floatingStyle.minWidth = `${Math.min(rects.reference.width, width)}px`;
        },
      }),
    ],
    [hasInlineMaxHeight, offset, matchWidth, maxWidthOverAnchor],
  );
  const { refs, floatingStyles, isPositioned } = useFloating({
    placement,
    strategy: "fixed",
    transform: false,
    middleware,
    elements: { reference },
    whileElementsMounted: resizable || maxWidthOverAnchor !== undefined ? watchPopupSize : autoUpdate,
  });
  const elRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // Read while rendering: content such as a menu focuses itself before any effect here runs.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  const layerId = useRef<number | null>(null);
  const outer = useContext(PopupAncestry);
  const ancestry = useMemo(() => [...outer, layerId], [outer]);
  const [size, setSize] = useState(() => (resizable && initialSize) || null);

  useEffect(() => {
    const layer = openLayer(() => elRef.current, closeOnDeactivate ? () => onCloseRef.current("outside") : undefined);
    layerId.current = layer.id;

    const onKey = (e: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current("escape");
      } else if (e.key === "Tab" && trapFocus && elRef.current) {
        trapTab(e, elRef.current);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!closeOnOutsideClick) return;
      const target = e.target as Node;
      if (layer.containsFromHere(target)) return;
      const ref = toReference(anchor);
      if (ref instanceof Element && ref.contains(target)) return;
      onCloseRef.current("outside");
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    const stopDeactivate = closeOnDeactivate ? onWindowDeactivate(() => onCloseRef.current("outside")) : undefined;
    return () => {
      stopDeactivate?.();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
      layer.release();
      const el = elRef.current;
      const active = document.activeElement;
      if (
        restoreFocus &&
        previous?.isConnected &&
        (!active || active === document.body || el?.contains(active) || !active.isConnected)
      ) {
        previous.focus({ preventScroll: true });
      }
    };
    // Anchor identity changes must not re-run open/close bookkeeping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    const el = elRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    target.focus({ preventScroll: true });
  }, [autoFocus]);

  const resize = (edge: ResizeEdge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = elRef.current;
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    const releaseCursor = lockDragCursor(EDGE_CURSOR[edge]);
    const start = { x: e.clientX, y: e.clientY };
    const rect = el.getBoundingClientRect();
    let last: { w: number; h: number } | null = null;
    const move = (ev: PointerEvent) => {
      if (!(ev.buttons & 1)) return up();
      const w = edge === "bottom" ? rect.width : rect.width + ev.clientX - start.x;
      const h = edge === "right" ? rect.height : rect.height + ev.clientY - start.y;
      last = {
        w: Math.min(Math.max(w, minWidth), window.innerWidth - rect.left - 6),
        h: Math.min(Math.max(h, minHeight), window.innerHeight - rect.top - 6),
      };
      setSize(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      releaseCursor();
      if (last) onResized?.(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return createPortal(
    <div
      ref={(node) => {
        elRef.current = node;
        refs.setFloating(node);
      }}
      data-popup=""
      role={role}
      aria-label={aria["aria-label"]}
      aria-describedby={aria["aria-describedby"]}
      tabIndex={-1}
      className={clsx(styles.popup, centered && styles.centered, !unstyled && styles.surface, className)}
      data-positioned={centered || isPositioned || undefined}
      data-resized={size ? "" : undefined}
      style={{ ...(!centered && floatingStyles), ...(size && { width: size.w, height: size.h }), ...style }}
    >
      <PopupAncestry.Provider value={ancestry}>{children}</PopupAncestry.Provider>
      {resizable && (
        <>
          <div className={styles.resizeRight} aria-hidden onPointerDown={resize("right")} />
          <div className={styles.resizeBottom} aria-hidden onPointerDown={resize("bottom")} />
          <div
            className={styles.resizeCorner}
            role="separator"
            aria-label={tx("Resize")}
            onPointerDown={resize("corner")}
          />
        </>
      )}
    </div>,
    document.body,
  );
}
