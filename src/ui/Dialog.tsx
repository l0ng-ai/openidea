import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { usePlatform } from "@/platform/platformInfo";
import { Button, IconButton } from "./Button";
import { Icon } from "./icons";
import { FOCUSABLE, onWindowDeactivate, openLayer, trapTab } from "./popupState";
import { useTx } from "@/platform/i18n";
import { selectableText } from "./selectableText";
import styles from "./Dialog.module.css";
import { isImeKey } from "@/platform/ime";

/**
 * `default`: filled accent button, triggered by Enter. `cancel`: Esc / close
 * button do the same. `extra`: any other action.
 */
export type DialogButtonRole = "default" | "cancel" | "extra";

export interface DialogButton {
  label: string;
  /** Defaults to the dialog's `onClose` for `cancel`. */
  onClick?: () => void;
  role?: DialogButtonRole;
  disabled?: boolean;
  /** Initial focus instead of the first field of the content. */
  autoFocus?: boolean;
  /** Tooltip (e.g. why the button is disabled). */
  title?: string;
}

export type DialogPlatform = "mac" | "other";

/** macOS chrome and button order everywhere except Windows / Linux. */
export function dialogPlatformOf(os: string): DialogPlatform {
  return os === "windows" || os === "linux" ? "other" : "mac";
}

export function useDialogPlatform(override?: DialogPlatform): DialogPlatform {
  const os = usePlatform((s) => s.os);
  return override ?? dialogPlatformOf(os);
}

const MAC_ORDER: Record<DialogButtonRole, number> = { cancel: -10, extra: 0, default: 100 };

/**
 * IntelliJ's DialogWrapper order. macOS (`sortActionsOnMac`): Cancel first, the
 * default action last, others in between. Elsewhere: declaration order with the
 * default action first, e.g. OK · Cancel · Apply.
 */
export function orderDialogButtons<T extends { role?: DialogButtonRole }>(
  buttons: readonly T[],
  platform: DialogPlatform,
): T[] {
  const role = (b: T) => b.role ?? "extra";
  if (platform === "mac") {
    return buttons
      .map((b, i) => ({ b, i }))
      .sort((x, y) => MAC_ORDER[role(x.b)] - MAC_ORDER[role(y.b)] || x.i - y.i)
      .map((x) => x.b);
  }
  return [...buttons.filter((b) => role(b) === "default"), ...buttons.filter((b) => role(b) !== "default")];
}

/** The right-aligned button row of a dialog, ordered for the platform. */
export function DialogButtons({
  buttons,
  onCancel,
  platform: override,
}: {
  buttons: readonly DialogButton[];
  /** Click handler of `cancel` buttons without their own. */
  onCancel?: () => void;
  platform?: DialogPlatform;
}) {
  const platform = useDialogPlatform(override);
  const tx = useTx();
  return (
    <div className={styles.buttons}>
      {orderDialogButtons(buttons, platform).map((b) => (
        <Button
          key={b.label}
          variant={b.role === "default" ? "primary" : "secondary"}
          disabled={b.disabled}
          title={tx(b.title)}
          data-autofocus={b.autoFocus ? "" : undefined}
          data-dialog-default={b.role === "default" ? "" : undefined}
          onClick={b.onClick ?? (b.role === "cancel" ? onCancel : undefined)}
        >
          {tx(b.label)}
        </Button>
      ))}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  /** Cancel: Escape, the close button / light, and `cancel` buttons without a handler. */
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Footer buttons; ordered per platform (see `orderDialogButtons`). */
  buttons?: readonly DialogButton[];
  /** Left side of the footer: checkboxes ("Don't ask again"), status, left-side actions. */
  footerStart?: ReactNode;
  /** Shows the round "?" help button at the bottom left. */
  onHelp?: () => void;
  /** Free-form footer for the rare dialog whose footer is not a button row. */
  footer?: ReactNode;
  width?: number | string;
  /**
   * `both` shows a corner grip resizing the window. The content lays out again
   * against the new size; a numeric `width` is also the minimum width.
   */
  resizable?: "both";
  /**
   * `top` places a lightweight modal popup (choosers, Search Everywhere) near
   * the top. Popups (also any dialog without a title) get no window title bar
   * and are not draggable.
   */
  position?: "center" | "top";
  className?: string;
  "aria-label"?: string;
  /** Close when clicking outside (default: only for `top` popups). */
  dismissOnBackdrop?: boolean;
  /** Close when the app window loses focus (default: popups only; never modal dialogs). */
  closeOnDeactivate?: boolean;
  /** @deprecated Dialogs never dim the window behind them; kept for call sites. */
  transparentBackdrop?: boolean;
  /** @deprecated Every centred dialog has window chrome; kept for call sites. */
  chrome?: "default" | "window";
  /** Test hook: force macOS or Windows/Linux chrome and button order. */
  platform?: DialogPlatform;
  /**
   * A Messages alert (IDEA `MessageDialogBuilder`): no title bar, this icon on the
   * left, the title in bold above the content, `footerStart` under the text.
   */
  icon?: MessageIconKind;
}

export type MessageIconKind = "question" | "info" | "warning" | "error";

const MESSAGE_GLYPH: Record<MessageIconKind, ReactNode> = {
  question: (
    <path
      d="M12.6 12.6a3.4 3.4 0 1 1 5 3c-1 .6-1.6 1.2-1.6 2.4v.6M16 22.2v.4"
      fill="none"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  info: <path d="M16 15v7M16 10.2v.4" fill="none" strokeWidth="2.6" strokeLinecap="round" />,
  warning: <path d="M16 11v6.5M16 21.6v.4" fill="none" strokeWidth="2.6" strokeLinecap="round" />,
  error: <path d="M12 12l8 8M20 12l-8 8" fill="none" strokeWidth="2.6" strokeLinecap="round" />,
};

function MessageIcon({ kind }: { kind: MessageIconKind }) {
  return (
    <svg
      className={clsx(styles.messageIcon, styles[kind])}
      width={32}
      height={32}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      {kind === "warning" ? (
        <path
          className={styles.messageShape}
          d="M13.4 4.6a3 3 0 0 1 5.2 0l11 19.4A3 3 0 0 1 27 28.5H5A3 3 0 0 1 2.4 24z"
        />
      ) : (
        <circle className={styles.messageShape} cx="16" cy="16" r="14" />
      )}
      <g className={styles.messageGlyph}>{MESSAGE_GLYPH[kind]}</g>
    </svg>
  );
}

/**
 * Modal dialog after IntelliJ's DialogWrapper: a window with the platform's
 * title bar (macOS traffic lights / title + close), draggable by it; Enter runs
 * the default button, Escape cancels; focus is trapped and restored.
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogInner {...props} />;
}

const ENTER_OWNERS =
  'textarea, button, a[href], select, form, [contenteditable=""], [contenteditable="true"], [role="listbox"], [role="tree"], [role="grid"], [role="menu"], [role="combobox"][aria-expanded="true"]';

function DialogInner({
  onClose,
  title,
  children,
  buttons,
  footerStart,
  onHelp,
  footer,
  width = 480,
  resizable,
  position = "center",
  className,
  dismissOnBackdrop,
  closeOnDeactivate,
  platform: platformOverride,
  icon,
  ...aria
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const platform = useDialogPlatform(platformOverride);
  const tx = useTx();
  if (typeof title === "string") title = tx(title);
  // Choosers and untitled dialogs (Recent Files, About) are IDEA popups.
  const popup = position === "top" || (title == null && !icon);
  const onCloseRef = useRef(onClose);
  const buttonsRef = useRef(buttons);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    buttonsRef.current = buttons;
  });

  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(() => typeof document === "undefined" || document.hasFocus());
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onFocus = () => setActive(true);
    const onBlur = () => setActive(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const cancelOnDeactivate = closeOnDeactivate ?? popup;
  useEffect(() => {
    if (!cancelOnDeactivate) return;
    return onWindowDeactivate(() => onCloseRef.current());
  }, [cancelOnDeactivate]);

  useEffect(() => {
    const layer = openLayer(() => ref.current);
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Content first (an alert's checkbox is not content), then the default button; never the title bar's close button.
    const target =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      (el?.hasAttribute("data-alert")
        ? null
        : el?.querySelector<HTMLElement>(`[data-dialog-body] :is(${FOCUSABLE})`)) ??
      el?.querySelector<HTMLElement>("[data-dialog-footer] [data-dialog-default]:not([disabled])") ??
      el?.querySelector<HTMLElement>(`[data-dialog-footer] :is(${FOCUSABLE})`) ??
      el;
    target?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!layer.isTop() || !ref.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        trapTab(e, ref.current);
      } else if (e.key === "Enter" && !e.defaultPrevented && !isImeKey(e) && !e.shiftKey && !e.altKey) {
        const t = e.target instanceof Element ? e.target : null;
        const mod = e.metaKey || e.ctrlKey;
        if (t && t !== document.body && !ref.current.contains(t)) return;
        if (!mod && t?.closest(ENTER_OWNERS)) return;
        const def = buttonsRef.current?.find((b) => b.role === "default");
        if (!def || def.disabled || !def.onClick) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        def.onClick();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      layer.release();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (
      popup ||
      e.button !== 0 ||
      (e.target as Element).closest(`button, input, label, a, select, textarea, .${selectableText}`)
    )
      return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const start = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    const rect = el.getBoundingClientRect();
    const base = { left: rect.left - offset.x, top: rect.top - offset.y };
    const move = (ev: globalThis.PointerEvent) => {
      // Keep the title bar reachable.
      const x = Math.min(
        Math.max(ev.clientX - start.x, -base.left - rect.width + 80),
        window.innerWidth - base.left - 80,
      );
      const y = Math.min(Math.max(ev.clientY - start.y, -base.top), window.innerHeight - base.top - 28);
      setOffset({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const label = aria["aria-label"] ?? (typeof title === "string" ? title : undefined);
  const hasFooter = !!(buttons?.length || footerStart || onHelp || footer);
  const canResize = resizable === "both" && !popup;

  const resize = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const rect = el.getBoundingClientRect();
    const minW = typeof width === "number" ? width : 320;
    const chrome = el.querySelector<HTMLElement>("[data-dialog-titlebar]")?.offsetHeight ?? 0;
    const minH = chrome + 120;
    const origin = offset;
    const move = (ev: globalThis.PointerEvent) => {
      const w = Math.min(Math.max(rect.width + ev.clientX - start.x, minW), window.innerWidth - 24);
      const h = Math.min(Math.max(rect.height + ev.clientY - start.y, minH), window.innerHeight - 24);
      setSize({ w, h });
      // The overlay centres the dialog: shift by half the growth so its top-left stays put.
      setOffset({ x: origin.x + (w - rect.width) / 2, y: origin.y + (h - rect.height) / 2 });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return createPortal(
    <div
      className={clsx(styles.backdrop, position === "top" && styles.top)}
      onPointerDown={(e) => {
        if ((dismissOnBackdrop ?? popup) && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-platform={platform}
        data-alert={icon ? "" : undefined}
        data-inactive={active ? undefined : ""}
        className={clsx(styles.dialog, popup ? styles.popup : styles.window, className)}
        style={{
          width: size ? size.w : width,
          height: size?.h,
          translate: offset.x || offset.y ? `${offset.x}px ${offset.y}px` : undefined,
        }}
      >
        {icon ? null : popup ? (
          title != null && (
            <div className={styles.popupHeader}>
              <span className={styles.title}>{title}</span>
            </div>
          )
        ) : platform === "mac" ? (
          <div className={clsx(styles.titleBar, styles.macTitleBar)} onPointerDown={drag} data-dialog-titlebar="">
            <span className={styles.lights}>
              <button
                type="button"
                tabIndex={-1}
                className={clsx(styles.light, styles.lightClose)}
                aria-label={tx("Close")}
                onClick={onClose}
              >
                <Icon name="close" size={10} className={styles.lightGlyph} />
              </button>
              <button type="button" tabIndex={-1} disabled className={styles.light} aria-label={tx("Minimize")} />
              <button type="button" tabIndex={-1} disabled className={styles.light} aria-label={tx("Zoom")} />
            </span>
            <span className={styles.title}>{title}</span>
          </div>
        ) : (
          <div className={styles.titleBar} onPointerDown={drag} data-dialog-titlebar="">
            <span className={styles.title}>{title}</span>
            <IconButton icon="close" title="Close" size="small" tabIndex={-1} onClick={onClose} />
          </div>
        )}
        {icon ? (
          <div className={styles.message} data-dialog-body="" onPointerDown={drag}>
            <MessageIcon kind={icon} />
            <div className={styles.messageText}>
              {title != null && <div className={clsx(styles.messageTitle, selectableText)}>{title}</div>}
              <div className={clsx(styles.messageBody, selectableText)}>
                {typeof children === "string" ? tx(children) : children}
              </div>
              {footerStart && <div className={styles.messageExtra}>{footerStart}</div>}
            </div>
          </div>
        ) : (
          <div className={styles.body} data-dialog-body="">
            {children}
          </div>
        )}
        {icon
          ? !!buttons?.length && (
              <div className={clsx(styles.footer, styles.messageFooter)} data-dialog-footer="" onPointerDown={drag}>
                <DialogButtons buttons={buttons} onCancel={onClose} platform={platform} />
              </div>
            )
          : hasFooter && (
              <div className={styles.footer} data-dialog-footer="">
                {onHelp && (
                  <button type="button" className={styles.help} aria-label={tx("Help")} onClick={onHelp}>
                    ?
                  </button>
                )}
                {footerStart && <div className={styles.footerStart}>{footerStart}</div>}
                {footer}
                {!!buttons?.length && <DialogButtons buttons={buttons} onCancel={onClose} platform={platform} />}
              </div>
            )}
        {canResize && (
          <div
            className={styles.resizeGrip}
            role="separator"
            aria-orientation="vertical"
            aria-label={tx("Resize")}
            onPointerDown={resize}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
