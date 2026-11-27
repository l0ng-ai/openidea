import clsx from "clsx";
import styles from "./Spinner.module.css";

export function Spinner({
  size = 14,
  className,
  label = "Loading",
  variant = "ring",
}: {
  size?: number;
  className?: string;
  label?: string;
  variant?: "ring" | "spokes";
}) {
  return (
    <svg
      className={clsx(styles.spinner, variant === "spokes" && styles.spokes, className)}
      width={size}
      height={size}
      viewBox={variant === "spokes" ? "0 0 16 16" : "0 0 24 24"}
      role="status"
      aria-label={label}
    >
      {variant === "spokes" ? (
        Array.from({ length: 8 }, (_, index) => (
          <rect
            key={index}
            x="7"
            y="1"
            width="2"
            height="4"
            rx="1"
            fill="currentColor"
            opacity={1 - index * 0.1}
            transform={`rotate(${-index * 45} 8 8)`}
          />
        ))
      ) : (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" />
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
