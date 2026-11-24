import { useSyncExternalStore } from "react";
import clsx from "clsx";
import { projectInitials } from "./projectColor";
import { subscribeTabColors, tabColorOverride, tabColorVars, tabColorsVersion } from "./tabColors";
import styles from "./ProjectBadge.module.css";

/** Square project avatar for a two-line row: the title bar widget's colour and initials. */
export function ProjectBadge({ name, path, className }: { name: string; path: string; className?: string }) {
  useSyncExternalStore(subscribeTabColors, tabColorsVersion);
  return (
    <span className={clsx(styles.badge, className)} style={tabColorVars(name, tabColorOverride(path))} aria-hidden>
      {projectInitials(name)}
    </span>
  );
}
