import { IconButton } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { BUILD_RUNNING } from "./store";
import styles from "./Build.module.css";

/** Run configuration kinds a project build precedes; scripts (Python, shell, Node…) have nothing to compile. */
const COMPILED_KINDS = new Set(["", "spring-boot", "application", "junit", "tomcat", "maven", "gradle"]);

/** Main toolbar hammer, left of the run widget, targeting the selected run configuration when possible. */
export function BuildTitleItem() {
  const tx = useTx();
  const cmake = useContextKeys((c) => (typeof c["run.cmakeBuild"] === "string" ? c["run.cmakeBuild"] : null));
  const target = useContextKeys((c) => (typeof c["run.buildTarget"] === "string" ? c["run.buildTarget"] : null));
  const targetName = useContextKeys((c) =>
    typeof c["run.buildTargetName"] === "string" ? c["run.buildTargetName"] : null,
  );
  const shown = useContextKeys(
    (c) =>
      !!c["run.cmakeBuild"] ||
      !!c["run.buildTarget"] ||
      ((!!c["build.maven"] || !!c["build.gradle"]) && COMPILED_KINDS.has(String(c["run.selectedKind"] ?? ""))),
  );
  const running = useContextKeys((c) => !!c[BUILD_RUNNING]);
  if (!shown) return null;

  const title = targetName ? tx`Build '${targetName}'` : tx("Build Project");
  const shortcut = !target ? shortcutLabel("build.buildProject") : undefined;

  const onClick = () => {
    if (cmake) {
      void executeAction("build.buildProject", { cmake });
    } else if (target) {
      void executeAction("build.buildModule", { target });
    } else {
      void executeAction("build.buildProject");
    }
  };

  return (
    <IconButton
      icon="build-project"
      size="large"
      iconSize={16}
      className={styles.titleButton}
      title={title}
      shortcut={shortcut}
      disabled={running}
      onClick={onClick}
    />
  );
}
