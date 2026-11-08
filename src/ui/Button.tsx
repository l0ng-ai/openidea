import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { getAction, executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, type IconName } from "./icons";
import { tooltipAttrs } from "./Tooltip";
import styles from "./Button.module.css";
import { useGivenTx } from "@/platform/i18n";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "normal" | "small";
  icon?: IconName | (string & {});
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "normal", icon, className, children, type = "button", title, ...rest },
  ref,
) {
  const tx = useGivenTx();
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(styles.button, styles[variant], size === "small" && styles.small, className)}
      title={tx(title)}
      {...rest}
    >
      {icon && <Icon name={icon} size={14} />}
      {typeof children === "string" ? tx(children) : children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon: IconName | (string & {});
  /** Accessible label and tooltip text. Defaults to the action's title. */
  title?: string;
  /** Run this action on click; supplies title + shortcut. */
  action?: string;
  actionArg?: unknown;
  /** Explicit shortcut label shown in the tooltip (defaults to the action's binding). */
  shortcut?: string;
  /** Toggle state (renders `aria-pressed`). */
  pressed?: boolean;
  size?: "small" | "normal" | "large";
  iconSize?: number;
  tone?: "default" | "danger" | "accent";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    title,
    action,
    actionArg,
    shortcut,
    pressed,
    size = "normal",
    iconSize,
    tone = "default",
    className,
    onClick,
    disabled,
    type = "button",
    "aria-label": ariaLabel,
    ...rest
  },
  ref,
) {
  const tx = useGivenTx();
  const a = action ? getAction(action) : undefined;
  const label = tx(title) ?? a?.title ?? action ?? icon;
  const keys = shortcut ?? (action ? shortcutLabel(action) : undefined);
  return (
    <button
      ref={ref}
      type={type}
      aria-label={tx(ariaLabel) ?? label}
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      disabled={disabled}
      className={clsx(styles.iconButton, styles[`is-${size}`], tone !== "default" && styles[`tone-${tone}`], className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && action) void executeAction(action, actionArg);
      }}
      {...tooltipAttrs(label, keys, true)}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === "small" ? 14 : 16)} />
    </button>
  );
});
