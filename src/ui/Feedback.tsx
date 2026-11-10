import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./Button";
import { Given } from "./T";
import { useTx } from "@/platform/i18n";
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

// Lives in its own module so `Button` can show it without importing this file back.
export { Spinner } from "./Spinner";

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
      {title && <div className={styles.emptyTitle}>{typeof title === "string" ? <Given>{title}</Given> : title}</div>}
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
  const tx = useTx();
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
            {typeof title === "string" ? <Given>{title}</Given> : title}
          </span>
          {meta && <span className={styles.toastMeta}>{meta}</span>}
        </div>
        {body && <div className={styles.toastBody}>{typeof body === "string" ? <Given>{body}</Given> : body}</div>}
        {actions && actions.length > 0 && (
          <div className={styles.toastActions}>
            {actions.map((a) => (
              <button key={a.label} type="button" className={styles.link} onClick={a.run}>
                <Given>{a.label}</Given>
              </button>
            ))}
          </div>
        )}
      </div>
      {onClose && (
        <IconButton
          icon="close"
          title={tx("Dismiss")}
          size="small"
          iconSize={12}
          className={styles.toastClose}
          onClick={onClose}
        />
      )}
    </div>
  );
}
