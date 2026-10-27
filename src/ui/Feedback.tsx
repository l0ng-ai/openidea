import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./Button";
import { T } from "./T";
import { selectableText } from "./selectableText";
import styles from "./Feedback.module.css";

export interface ProgressBarProps {
  /** 0..1; `null`/`undefined` renders the indeterminate animation. */
  value?: number | null;
  className?: string;
  "aria-label"?: string;
}

/** Thin 2px progress line. */
export function ProgressBar({ value, className, ...aria }: ProgressBarProps) {
  const determinate = value != null;
  return (
    <div
      role="progressbar"
      aria-label={aria["aria-label"]}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      className={clsx(styles.progress, !determinate && styles.indeterminate, className)}
    >
      <div
        className={styles.bar}
        style={determinate ? { transform: `scaleX(${Math.max(0, Math.min(1, value))})` } : undefined}
      />
    </div>
  );
}

export function Spinner({
  size = 14,
  className,
  label = "Loading",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={clsx(styles.spinner, className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export interface BadgeProps {
  children: ReactNode;
  tone?: "neutral" | "accent" | "danger" | "warning" | "success";
  /** Small dot instead of a pill (`children` is used as the accessible label). */
  dot?: boolean;
  className?: string;
}

export function Badge({ children, tone = "neutral", dot, className }: BadgeProps) {
  if (dot)
    return (
      <span
        className={clsx(styles.dot, styles[`tone-${tone}`], className)}
        role="status"
        aria-label={String(children)}
      />
    );
  return <span className={clsx(styles.badge, styles[`tone-${tone}`], className)}>{children}</span>;
}

export interface EmptyStateProps {
  title?: ReactNode;
  icon?: IconName | (string & {});
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** IntelliJ "empty text": centred grey lines, no illustration (`icon` is accepted but not shown). */
export function EmptyState({ title, children, actions, className }: EmptyStateProps) {
  return (
    <div className={clsx(styles.empty, className)}>
      {title && <div className={styles.emptyTitle}>{typeof title === "string" ? <T>{title}</T> : title}</div>}
      {children && <div className={styles.emptyBody}>{children}</div>}
      {actions && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}

export type ToastLevel = "info" | "warning" | "error" | "success";

export interface ToastProps {
  level: ToastLevel;
  title: ReactNode;
  body?: ReactNode;
  actions?: Array<{ label: string; run: () => void }>;
  onClose?: () => void;
  /** Muted timestamp / source shown next to the title. */
  meta?: ReactNode;
  className?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

const LEVEL_ICON: Record<ToastLevel, IconName> = { info: "info", warning: "warning", error: "error", success: "check" };

/** IDEA-style notification balloon. */
export function Toast({
  level,
  title,
  body,
  actions,
  onClose,
  meta,
  className,
  onPointerEnter,
  onPointerLeave,
}: ToastProps) {
  return (
    <div
      className={clsx(styles.toast, className)}
      role={level === "error" ? "alert" : "status"}
      data-level={level}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <Icon name={LEVEL_ICON[level]} size={16} className={clsx(styles.toastIcon, styles[`level-${level}`])} />
      <div className={styles.toastMain}>
        <div className={styles.toastHead}>
          <span className={clsx(styles.toastTitle, selectableText)}>
            {typeof title === "string" ? <T>{title}</T> : title}
          </span>
          {meta && <span className={styles.toastMeta}>{meta}</span>}
        </div>
        {body && <div className={styles.toastBody}>{typeof body === "string" ? <T>{body}</T> : body}</div>}
        {actions && actions.length > 0 && (
          <div className={styles.toastActions}>
            {actions.map((a) => (
              <button key={a.label} type="button" className={styles.link} onClick={a.run}>
                <T>{a.label}</T>
              </button>
            ))}
          </div>
        )}
      </div>
      {onClose && (
        <IconButton
          icon="close"
          title="Dismiss"
          size="small"
          iconSize={12}
          className={styles.toastClose}
          onClick={onClose}
        />
      )}
    </div>
  );
}
