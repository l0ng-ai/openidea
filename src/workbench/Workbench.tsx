/**
 * The IDEA-style shell (Islands): title bar, tool window stripes and island
 * panels around the editor area on the frame background, status bar, and the
 * overlay layer. Without an open project the welcome view replaces the frame,
 * or, editing loose files (LightEdit), a frame with the editor only.
 */
import { useEditorRegistry } from "@/editor/api";
import { basename, useProject } from "@/platform/project";
import { useT } from "@/platform/i18n";
import { ProgressBar } from "@/ui";
import projectMark from "../../src-tauri/icons/source/openidea-mark.svg";
import { useDistractionFree } from "./distractionFree";
import { EditorArea } from "./EditorArea";
import { OverlayHost } from "./OverlayHost";
import { projectColorVars } from "./projectColor";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { WindowGroupTabs } from "./WindowGroupTabs";
import { useApplyTheme } from "./theme";
import { ToolWindowLayout } from "./toolwindows/ToolWindows";
import { Welcome } from "./Welcome";
import { WindowResizeHandles } from "./WindowResizeHandles";
import { useContributions } from "./contributions";
import styles from "./Workbench.module.css";

/** LightEdit: editor tabs only; no tool windows, toolbar widgets or project status items. */
function LightEditFrame() {
  const path = useEditorRegistry((s) => s.active?.ctx.path);
  const distractionFree = useDistractionFree((s) => s.active);
  return (
    <>
      <TitleBar lightEdit bare={distractionFree} title={path ? basename(path) : "LightEdit"} />
      <main className={styles.lightEdit} data-light-edit>
        <div className={styles.lightEditIsland}>
          <EditorArea />
        </div>
      </main>
      {!distractionFree && <StatusBar lightEdit />}
    </>
  );
}

function ProjectOpening({ path }: { path: string }) {
  const t = useT();
  const label = t("app.project.opening", { name: basename(path) });
  return (
    <div className={styles.opening} data-project-opening>
      <TitleBar bare />
      <div className={styles.openingBody} role="status" aria-label={label}>
        <div className={styles.openingBrand} aria-hidden="true">
          <img className={styles.openingLogo} src={projectMark} alt="" draggable={false} />
          <span>OpenIDEA</span>
        </div>
        <ProgressBar className={styles.openingProgress} aria-label={label} />
        <div className={styles.openingTitle}>{label}</div>
        <div className={styles.openingPath} title={path}>
          {path}
        </div>
      </div>
    </div>
  );
}

export function Workbench() {
  useApplyTheme();
  const banners = useContributions((s) => s.workbenchBanners);
  const project = useProject((s) => s.project);
  const lightEdit = useProject((s) => s.lightEdit);
  const openingPath = useProject((s) => s.openingPath);
  const root = project?.root ?? null;
  const distractionFree = useDistractionFree((s) => s.active);
  const frame = project ? styles.framed : lightEdit ? styles.lightEditFrame : undefined;

  return (
    <div
      className={frame ? `${styles.workbench} ${frame}` : styles.workbench}
      style={project ? projectColorVars(project.name) : undefined}
    >
      <div className={styles.content} inert={openingPath !== null} aria-hidden={openingPath ? true : undefined}>
        {project ? (
          <>
            {/* Distraction Free Mode keeps the bar for the traffic lights and window dragging only. */}
            <TitleBar bare={distractionFree} />
            {!distractionFree && <WindowGroupTabs />}
            {[...banners.values()].map(({ id, component: Banner }) => (
              <Banner key={id} />
            ))}
            <ToolWindowLayout key={root} editor={<EditorArea />} />
            {!distractionFree && <StatusBar />}
          </>
        ) : lightEdit ? (
          <LightEditFrame />
        ) : (
          <Welcome />
        )}
      </div>
      {openingPath && <ProjectOpening path={openingPath} />}
      <OverlayHost />
      <WindowResizeHandles />
    </div>
  );
}
