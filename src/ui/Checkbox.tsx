import { useId, type ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "./icons";
import styles from "./Checkbox.module.css";
import { useTx } from "@/platform/i18n";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** Tri-state display. */
  indeterminate?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate, className, ...aria }: CheckboxProps) {
  const id = useId();
  const tx = useTx();
  return (
    <label className={clsx(styles.row, disabled && styles.disabled, className)} htmlFor={id}>
      <span className={styles.boxWrap}>
        <input
          id={id}
          type="checkbox"
          className={styles.native}
          checked={checked}
          disabled={disabled}
          aria-checked={indeterminate ? "mixed" : checked}
          aria-label={tx(aria["aria-label"])}
          onChange={(e) => onChange(e.target.checked)}
          ref={(el) => {
            if (el) el.indeterminate = !!indeterminate;
          }}
        />
        <span className={clsx(styles.box, (checked || indeterminate) && styles.on)} aria-hidden>
          {indeterminate ? <Icon name="minus" size={12} /> : checked ? <Icon name="check" size={12} /> : null}
        </span>
      </span>
      {label != null && <span className={styles.label}>{typeof label === "string" ? tx(label) : label}</span>}
    </label>
  );
}

export interface RadioProps {
  checked: boolean;
  onChange: () => void;
  /** Radios with the same name form one group, moved through with the arrow keys. */
  name: string;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Radio button, drawn like the checkbox with a round box and a dot. */
export function Radio({ checked, onChange, name, label, disabled, className }: RadioProps) {
  const id = useId();
  const tx = useTx();
  return (
    <label className={clsx(styles.row, disabled && styles.disabled, className)} htmlFor={id}>
      <span className={styles.boxWrap}>
        <input
          id={id}
          type="radio"
          name={name}
          className={styles.native}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
        <span className={clsx(styles.box, styles.radio, checked && styles.on)} aria-hidden />
      </span>
      {label != null && <span className={styles.label}>{typeof label === "string" ? tx(label) : label}</span>}
    </label>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Switch (`role="switch"`), drawn as IDEA's ON/OFF button. */
export function Toggle({ checked, onChange, label, disabled, className, ...aria }: ToggleProps) {
  return (
    <label className={clsx(styles.row, disabled && styles.disabled, className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        className={clsx(styles.switch, checked && styles.switchOn)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} />
        <span className={styles.knobLabel} aria-hidden>
          {checked ? "ON" : "OFF"}
        </span>
      </button>
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  );
}
