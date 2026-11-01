/**
 * Anchored popover: portal + flip/shift positioning, Escape / outside-click /
 * window-deactivation dismissal (top-most popup only for Escape), optional
 * focus trap and focus restore.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  type Placement,
  type VirtualElement,
} from "@floating-ui/react-dom";
import { FOCUSABLE, onWindowDeactivate, openLayer, trapTab } from "./popupState";
import styles from "./Popup.module.css";

export type PopupAnchor = Element | VirtualElement | RefObject<Element | null> | { x: number; y: number } | null;

export interface PopupProps {
  open: boolean;
  onClose: (reason: "escape" | "outside" | "action") => void;
  anchor: PopupAnchor;
  placement?: Placement;
  offset?: number;
  /** Additional room below the popup for fixed UI such as the workbench status bar. */
  viewportBottomPadding?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  role?: string;
  "aria-label"?: string;
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
  /** Plain surface without border/shadow styling. */
  unstyled?: boolean;
}

function toReference(anchor: PopupAnchor): Element | VirtualElement | null {
  if (!anchor) return null;
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
  viewportBottomPadding = 6,
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
  unstyled = false,
  ...aria
}: PopupProps) {
  const reference = toReference(anchor);
  const middleware = useMemo(
    () => [
      offsetMw(offset),
      flip({ padding: { top: 6, right: 6, bottom: viewportBottomPadding, left: 6 } }),
      shift({ padding: { top: 6, right: 6, bottom: viewportBottomPadding, left: 6 } }),
      sizeMw({
        padding: { top: 6, right: 6, bottom: viewportBottomPadding, left: 6 },
        apply({ rects, elements, availableHeight }) {
          elements.floating.style.maxHeight = `${Math.max(120, availableHeight)}px`;
          if (matchWidth) elements.floating.style.minWidth = `${rects.reference.width}px`;
        },
      }),
    ],
    [offset, matchWidth, viewportBottomPadding],
  );
  const { refs, floatingStyles, isPositioned } = useFloating({
    placement,
    strategy: "fixed",
    transform: false,
    middleware,
    elements: { reference },
    whileElementsMounted: autoUpdate,
  });
  const elRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // Read while rendering: content such as a menu focuses itself before any effect here runs.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const layer = openLayer(() => elRef.current);

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

  return createPortal(
    <div
      ref={(node) => {
        elRef.current = node;
        refs.setFloating(node);
      }}
      data-popup=""
      role={role}
      aria-label={aria["aria-label"]}
      tabIndex={-1}
      className={clsx(styles.popup, !unstyled && styles.surface, className)}
      data-positioned={isPositioned || undefined}
      style={{ ...floatingStyles, ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
