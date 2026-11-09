import { IconButton } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { BUILD_RUNNING } from "./store";
import styles from "./Build.module.css";

/** Run configuration kinds a project build precedes; scripts (Python, shell, Node…) have nothing to compile. */
const COMPILED_KINDS = new Set(["", "spring-boot", "application", "maven", "gradle"]);

/** Main toolbar hammer, left of the run widget, for compiled project configurations. */
export function BuildTitleItem() {
  const shown = useContextKeys(
    (c) =>
      !!c["run.cmakeBuild"] ||
      ((!!c["build.maven"] || !!c["build.gradle"]) && COMPILED_KINDS.has(String(c["run.selectedKind"] ?? ""))),
  );
  const running = useContextKeys((c) => !!c[BUILD_RUNNING]);
  if (!shown) return null;
  return (
    <IconButton
      icon="build-project"
      size="large"
      iconSize={16}
      className={styles.titleButton}
      title="Build Project"
      shortcut={shortcutLabel("build.buildProject")}
      disabled={running}
      onClick={() => void executeAction("build.buildProject")}
    />
  );
}
