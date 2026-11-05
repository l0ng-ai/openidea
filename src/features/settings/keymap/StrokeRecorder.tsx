/**
 * Focusable field that records keystrokes instead of text. The global keymap
 * dispatcher is suspended while it has focus so shortcuts don't fire.
 */
import { forwardRef, useEffect, useRef, type KeyboardEvent } from "react";
import clsx from "clsx";
import { formatBinding, strokeOf, suspendKeyboardDispatch } from "@/platform/keymap";
import { T } from "@/ui";
import styles from "./Keymap.module.css";

export interface StrokeRecorderProps {
  /** Recorded binding (one stroke, or a chord when `chord`). */
  value: string;
  onChange: (binding: string) => void;
  /** Append strokes pressed within the chord timeout (max two) instead of replacing. */
  chord?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label": string;
}

const CHORD_MS = 1200;

export const StrokeRecorder = forwardRef<HTMLDivElement, StrokeRecorderProps>(function StrokeRecorder(
  { value, onChange, chord, placeholder = "Press a shortcut", autoFocus, disabled, className, ...aria },
  ref,
) {
  const resume = useRef<(() => void) | null>(null);
  const lastAt = useRef(0);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (autoFocus) el?.focus();
    // Already focused (e.g. effects re-run) means no focus event: suspend here.
    if (el && document.activeElement === el && !resume.current) resume.current = suspendKeyboardDispatch();
    return () => {
      resume.current?.();
      resume.current = null;
    };
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const stroke = strokeOf(e.nativeEvent);
    if (!stroke) return;
    const now = e.timeStamp || performance.now();
    const appending = chord && value && !value.includes(" ") && now - lastAt.current < CHORD_MS;
    lastAt.current = now;
    onChange(appending ? `${value} ${stroke}` : stroke);
  };

  return (
    <div
      ref={(el) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      role="textbox"
      aria-readonly="true"
      aria-label={aria["aria-label"]}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-autofocus={autoFocus || undefined}
      className={clsx(styles.recorder, disabled && styles.recorderDisabled, className)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        resume.current?.();
        resume.current = suspendKeyboardDispatch();
      }}
      onBlur={() => {
        resume.current?.();
        resume.current = null;
      }}
    >
      {value ? (
        <span className={styles.recorded}>{formatBinding(value)}</span>
      ) : (
        <span className={styles.recorderPlaceholder}>
          <T>{placeholder}</T>
        </span>
      )}
    </div>
  );
});
