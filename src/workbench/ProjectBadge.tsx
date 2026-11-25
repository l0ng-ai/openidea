import { useSyncExternalStore } from "react";
import clsx from "clsx";
import { projectInitials } from "./projectColor";
import { useProjectIcon } from "./projectIcon";
import { subscribeTabColors, tabColorOverride, tabColorVars, tabColorsVersion } from "./tabColors";
import styles from "./ProjectBadge.module.css";

/** Square project avatar for a two-line row: the title bar widget's colour and initials. */
export function ProjectBadge({ name, path, className }: { name: string; path: string; className?: string }) {
  useSyncExternalStore(subscribeTabColors, tabColorsVersion);
  return (
    <span className={clsx(styles.badge, className)} style={tabColorVars(name, tabColorOverride(path))} aria-hidden>
      <ProjectAvatar name={name} root={path} />
    </span>
  );
}

/**
 * An avatar's content: the project's own icon (Change Project Icon…, `.idea/icon.svg`) when it has
 * one, else its initials. The avatar drops its colour behind an icon (`:has(> img)`).
 */
export function ProjectAvatar({ name, root }: { name: string; root: string | null | undefined }) {
  const icon = useProjectIcon(root);
  return icon ? <img className={styles.icon} src={icon} alt="" draggable={false} /> : <>{projectInitials(name)}</>;
}
