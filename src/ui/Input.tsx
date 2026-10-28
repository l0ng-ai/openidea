import {
  forwardRef,
  useEffect,
  useRef,
  type InputHTMLAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./Button";
import styles from "./Input.module.css";
import { setContext } from "@/platform/context";
import { useTx } from "@/platform/i18n";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  invalid?: boolean;
  mono?: boolean;
  /** `bare` drops the frame (for inputs embedded in popups / headers). */
  variant?: "framed" | "bare";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, variant = "framed", className, spellCheck = false, autoComplete = "off", placeholder, "aria-label": ariaLabel, ...rest },
  ref,
) {
  const tx = useTx();
  return (
    <input
      ref={ref}
      spellCheck={spellCheck}
      autoComplete={autoComplete}
      autoCorrect="off"
      autoCapitalize="off"
      aria-invalid={invalid || undefined}
      placeholder={tx(placeholder)}
      aria-label={tx(ariaLabel)}
      className={clsx(styles.input, variant === "bare" ? styles.bare : styles.framed, mono && styles.mono, className)}
      {...rest}
    />
  );
});

export interface SearchToggle {
  id: string;
  icon: IconName | (string & {});
  title: string;
  shortcut?: string;
  pressed: boolean;
  onToggle: (pressed: boolean) => void;
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> {
  value: string;
  onChange: (value: string) => void;
  leadingIcon?: IconName | (string & {}) | null;
  /** Trailing toggle buttons such as Match Case / Words / Regex. */
  toggles?: SearchToggle[];
  /** Extra trailing content (e.g. a result counter). */
  trailing?: ReactNode;
  clearable?: boolean;
  invalid?: boolean;
  size?: "normal" | "large";
  variant?: "framed" | "bare";
  className?: string;
  /**
   * IDEA's multi-line search field: always a text area that grows with the
   * text, plus a New Line button (⇧⌘↵ / ⇧Ctrl↵ inserts one too).
   */
  multiline?: boolean;
  /** Turns the leading magnifier into IDEA's search-history button (magnifier ▾). */
  onHistory?: () => void;
}

const isNewLineKey = (e: KeyboardEvent) => e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey;

interface FieldCommands {
  newLine?: () => void;
  history?: () => void;
}
let focusedField: FieldCommands | null = null;

/**
 * New Line / Recent Searches in the focused search field, for the shortcut
 * actions that win over editor bindings of the same keys (contexts
 * `searchFieldNewLine` / `searchFieldHistory`).
 */
export function runSearchFieldCommand(command: keyof FieldCommands): boolean {
  const run = focusedField?.[command];
  run?.();
  return !!run;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  {
    value,
    onChange,
    leadingIcon = "search",
    toggles,
    trailing,
    clearable = true,
    invalid,
    size = "normal",
    variant = "framed",
    className,
    placeholder,
    multiline,
    onHistory,
    "aria-label": ariaLabel,
    ...rest
  },
  ref,
) {
  const tx = useTx();
  const inner = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el as HTMLInputElement);
    else if (ref) ref.current = el as HTMLInputElement;
  };
  const insertNewLine = () => {
    const el = inner.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}\n${value.slice(end)}`);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + 1, start + 1);
    }, 0);
  };
  const commands = useRef<FieldCommands>({});
  // oxlint-disable-next-line react/refs -- latest-callback ref, read only from event handlers
  commands.current.newLine = multiline ? insertNewLine : undefined;
  // oxlint-disable-next-line react/refs
  commands.current.history = onHistory;
  const { onKeyDown, onFocus, onBlur, ...fieldProps } = rest;
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (multiline && isNewLineKey(e)) {
      e.preventDefault();
      insertNewLine();
      return;
    }
    onKeyDown?.(e);
  };
  const focus = (e: FocusEvent<HTMLInputElement>) => {
    focusedField = commands.current;
    setContext("searchFieldNewLine", !!multiline);
    setContext("searchFieldHistory", !!onHistory);
    onFocus?.(e);
  };
  const blur = (e: FocusEvent<HTMLInputElement>) => {
    if (focusedField === commands.current) {
      focusedField = null;
      setContext("searchFieldNewLine", false);
      setContext("searchFieldHistory", false);
    }
    onBlur?.(e);
  };
  const handlers = { onKeyDown: keyDown, onFocus: focus, onBlur: blur };
  // Removing a focused field fires no blur.
  useEffect(() => {
    const own = commands.current;
    return () => {
      if (focusedField !== own) return;
      focusedField = null;
      setContext("searchFieldNewLine", false);
      setContext("searchFieldHistory", false);
    };
  }, []);
  // A multi-line query (e.g. Find over a multi-line selection) is shown as such.
  const lines = value.split("\n").length;
  const iconSize = size === "large" ? 15 : 14;
  return (
    <div
      className={clsx(
        styles.searchField,
        variant === "framed" && styles.framed,
        size === "large" && styles.large,
        invalid && styles.invalid,
        lines > 1 && styles.multiline,
        className,
      )}
      data-invalid={invalid || undefined}
    >
      {onHistory ? (
        <IconButton
          icon="search-history"
          title="Recent Searches"
          shortcut="⌥↓"
          size="small"
          iconSize={iconSize}
          tabIndex={-1}
          className={styles.leading}
          onClick={onHistory}
        />
      ) : (
        leadingIcon && <Icon name={leadingIcon} size={iconSize} className={styles.leading} />
      )}
      {lines > 1 || multiline ? (
        <textarea
          ref={setRef as Ref<HTMLTextAreaElement>}
          className={clsx(styles.searchInput, styles.searchArea, lines === 1 && styles.searchAreaSingle)}
          rows={Math.min(lines, 5)}
          wrap="off"
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={invalid || undefined}
          aria-multiline={multiline || undefined}
          placeholder={tx(placeholder)}
          aria-label={tx(ariaLabel)}
          onChange={(e) => onChange(e.target.value)}
          {...(handlers as unknown as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          {...(fieldProps as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        />
      ) : (
        <input
          ref={setRef as Ref<HTMLInputElement>}
          className={styles.searchInput}
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={invalid || undefined}
          placeholder={tx(placeholder)}
          aria-label={tx(ariaLabel)}
          onChange={(e) => onChange(e.target.value)}
          {...handlers}
          {...fieldProps}
        />
      )}
      {trailing}
      {clearable && value && (
        <IconButton icon="close" title="Clear" size="small" iconSize={12} tabIndex={-1} onClick={() => onChange("")} />
      )}
      {multiline && (
        <IconButton
          icon="new-line"
          title="New Line"
          shortcut="⇧⌘↵"
          size="small"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={insertNewLine}
        />
      )}
      {toggles?.map((t) => (
        <IconButton
          key={t.id}
          icon={t.icon}
          title={t.title}
          shortcut={t.shortcut}
          size="small"
          pressed={t.pressed}
          onClick={() => t.onToggle(!t.pressed)}
        />
      ))}
    </div>
  );
});
