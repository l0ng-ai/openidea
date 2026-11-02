import clsx from "clsx";
import styles from "./SegmentedControl.module.css";

export interface SegmentOption<T extends string> {
  label: string;
  value: T;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (val: T) => void;
  className?: string;
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className={clsx(styles.segmented, className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={clsx(styles.option, isActive && styles.active)}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
