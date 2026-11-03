/**
 * Small pull request badges: the state tag (IntelliJ's `Review.State` pill), label chips
 * (the label's colour, as the timeline and create form show them) and branch chips.
 */
import clsx from "clsx";
import { Icon } from "@/ui";
import type { GHLabel, GHPullRequestState } from "../api/types";
import { stateTagText } from "../data/model";
import styles from "./ui.module.css";

/** DRAFT / CLOSED / MERGED pill; nothing for an open pull request. */
export function StateTag({
  state,
  isDraft,
  className,
}: {
  state: GHPullRequestState;
  isDraft: boolean;
  className?: string;
}) {
  const text = stateTagText(state, isDraft);
  if (!text) return null;
  return <span className={clsx(styles.stateTag, className)}>{text}</span>;
}

/** Black or white, whichever reads better on `hex` (`RRGGBB`, no `#`). */
export function labelForeground(hex: string): string {
  const n = Number.parseInt(hex.replace(/^#/, ""), 16);
  if (Number.isNaN(n)) return "var(--fg)";
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000000" : "#ffffff";
}

/** `#RRGGBB` of a GitHub label colour. */
export const labelColor = (label: Pick<GHLabel, "color">) => `#${label.color.replace(/^#/, "")}`;

export function LabelChip({ label, className }: { label: Pick<GHLabel, "name" | "color">; className?: string }) {
  return (
    <span
      className={clsx(styles.labelChip, className)}
      style={{ background: labelColor(label), color: labelForeground(label.color) }}
      title={label.name}
    >
      {label.name}
    </span>
  );
}

/** The 16px colour square of label pickers. */
export function LabelSwatch({ label }: { label: Pick<GHLabel, "color"> }) {
  return <span className={styles.labelSwatch} style={{ background: labelColor(label) }} aria-hidden />;
}

/** A branch name with the branch icon (`current`: the checked-out branch's icon). */
export function BranchChip({ name, current, className }: { name: string; current?: boolean; className?: string }) {
  return (
    <span className={clsx(styles.branchChip, className)} title={name}>
      <Icon name={current ? "current-branch-label" : "branch-label"} size={16} />
      <span>{name}</span>
    </span>
  );
}
