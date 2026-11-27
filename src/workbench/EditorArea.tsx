import { executeAction, useActions } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { T } from "@/ui";
import { useWorkbenchSlots } from "./contributions";
import { ErrorBoundary, Slot } from "./ErrorBoundary";
import { useEffectiveVisible, useToolWindows } from "./toolwindows/ToolWindows";
import styles from "./EditorArea.module.css";

type Hint = { label: string; action?: string; fallback?: string };

const HINTS: Hint[] = [
  { label: "Search Everywhere", action: "navigate.searchEverywhere", fallback: "Double ⇧" },
  { label: "Project", action: "toolwindow.project" },
  { label: "Go to File", action: "navigate.gotoFile" },
  { label: "Recent Files", action: "navigate.recentFiles" },
  { label: "Navigation Bar", action: "navigate.navigationBar", fallback: "⌥Home" },
  { label: "Drop files here to open them" },
];

/** LightEdit has no project to navigate: only opening and creating files works there. */
const LIGHT_EDIT_HINTS: Hint[] = [
  { label: "New File", action: "file.newUntitled" },
  { label: "Open File", action: "file.openFile" },
  { label: "Drop files here to open them" },
];

/** The empty editor's actions and their current shortcuts. */
export function EmptyEditor() {
  const actions = useActions((s) => s.actions);
  const lightEdit = useProject((s) => s.lightEdit);
  const hasProject = useProject((s) => !!s.project);
  const visible = useEffectiveVisible(useToolWindows());
  const showProject = hasProject && actions.has("toolwindow.project") && !Object.values(visible).includes("project");
  return (
    <div className={styles.empty}>
      <dl className={styles.hints}>
        {(lightEdit ? LIGHT_EDIT_HINTS : HINTS).map((h) => {
          if (h.action === "toolwindow.project" && !showProject) return null;
          const keys = h.action ? (shortcutLabel(h.action) ?? h.fallback) : undefined;
          const runnable = !!h.action && actions.has(h.action);
          return (
            <div key={h.label} className={styles.hint}>
              <dt>
                {runnable ? (
                  <button type="button" className={styles.hintButton} onClick={() => void executeAction(h.action!)}>
                    <T>{h.label}</T>
                  </button>
                ) : (
                  <T>{h.label}</T>
                )}
              </dt>
              {h.action && <dd className={styles.keys}>{keys}</dd>}
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function EditorArea() {
  const Provided = useWorkbenchSlots((s) => s.editorArea);
  return (
    <div className={styles.area} data-editor-area="" tabIndex={-1}>
      {Provided ? (
        <ErrorBoundary name="editor area" fallback={<EmptyEditor />}>
          <Slot component={Provided} />
        </ErrorBoundary>
      ) : (
        <EmptyEditor />
      )}
    </div>
  );
}
