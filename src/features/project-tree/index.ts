/** Project view: the "project" tool window, its file operations and actions. */
import { onEditorEvent, openEditorPaths } from "@/editor/api";
import { onIdeEvent } from "@/platform/ipc";
import { validateProjectStructure, type RootFolder } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { initProjectRoots, useProjectRoots } from "@/platform/projectRoots";
import { folderIconName } from "@/ui";
import {
  localChangedPaths,
  provideProjectViewSelection,
  registerOverlay,
  registerProjectViewRoot,
  registerToolWindow,
  useLocalChanges,
  useProjectViewRoots,
} from "@/workbench/contributions";
import { registerProjectActions } from "./actions";
import { FileRefactorDialogHost } from "./FileRefactorDialogs";
import { NewPopupHost } from "./NewPopup";
import { RefactoringPreviewHost } from "./RefactoringPreview";
import { ProjectHeaderActions, useProjectHeaderMenu, useProjectTitleMenu } from "./HeaderActions";
import { loadHomeDir } from "./home";
import { selectedNodes } from "./operations";
import { ProjectView } from "./ProjectView";
import { applyFsChange, initProjectTree, reloadAll, setChangedFiles, setOpenFiles, useProjectTree } from "./store";

export function activate(): () => void {
  loadHomeDir();
  const sync = () => {
    const p = useProject.getState().project;
    const s = useProjectTree.getState();
    if ((p?.root ?? null) !== s.root) initProjectTree(p?.root ?? null, p?.name ?? "");
    else if (p && p.name !== s.name) useProjectTree.setState({ name: p.name });
  };
  sync();
  const unsubProject = useProject.subscribe((s, prev) => {
    if (s.project !== prev.project) sync();
  });
  // Excluded folders / exclude globs change which entries are `ignored`.
  const unsubExcludes = useProject.subscribe((s, prev) => {
    const ex = (x: typeof s.settings) =>
      JSON.stringify([
        x?.files?.exclude,
        x?.projectStructure?.excluded,
        x?.projectStructure?.unmarked,
        x?.projectStructure?.excludeFiles,
      ]);
    if (s.settings !== prev.settings && prev.settings && ex(s.settings) !== ex(prev.settings)) void reloadAll();
  });
  // …and so do excluded roots detected from build files (`target`, `node_modules`, …).
  const disposeRoots = initProjectRoots();
  const detectedExcluded = (s: { root: string | null; detected: readonly RootFolder[] }) =>
    JSON.stringify([s.root, s.detected.filter((r) => r.kind === "excluded").map((r) => r.path)]);
  const unsubRoots = useProjectRoots.subscribe((s, prev) => {
    if (s.root && s.root === prev.root && detectedExcluded(s) !== detectedExcluded(prev)) void reloadAll();
  });

  // Project Structure content roots besides the project folder, listed after it.
  let contentRoots: Array<() => void> = [];
  let shownRoots = "";
  const syncContentRoots = () => {
    const { project, settings } = useProject.getState();
    const paths = project ? validateProjectStructure(settings?.projectStructure).contentRoots : [];
    const key = JSON.stringify(paths);
    if (key === shownRoots) return;
    shownRoots = key;
    contentRoots.forEach((d) => d());
    contentRoots = paths.map((path, i) =>
      registerProjectViewRoot({
        id: `contentRoot:${path}`,
        label: path.slice(path.lastIndexOf("/") + 1) || path,
        detail: path,
        icon: folderIconName("module"),
        path,
        order: -100 + i,
      }),
    );
  };
  syncContentRoots();
  const unsubContentRoots = useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings || s.project !== prev.project) syncContentRoots();
  });

  // Contributed roots (Scratches) are part of the derived model: re-render.
  const unsubExtraRoots = useProjectViewRoots.subscribe(() =>
    useProjectTree.setState((s) => ({ listings: new Map(s.listings) })),
  );

  // Open Files / All Changed Files panes: editor tabs and VCS changes, via the editor API and decorations.
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const syncOpenFiles = () => {
    clearTimeout(openTimer);
    // Tabs update after the document events.
    openTimer = setTimeout(() => setOpenFiles(openEditorPaths()), 0);
  };
  syncOpenFiles();
  const unsubEditor = onEditorEvent((e) => {
    if (e.type === "docOpened" || e.type === "docClosed" || e.type === "activeEditorChanged") syncOpenFiles();
  });
  // "All Changed Files": change-list files still on disk (IDEA leaves out unversioned, ignored and deleted ones).
  const syncChanged = () => setChangedFiles(localChangedPaths(useLocalChanges.getState().lists, null, true));
  syncChanged();
  const unsubDecorations = useLocalChanges.subscribe((s, prev) => {
    if (s.lists !== prev.lists) syncChanged();
  });

  const disposers = [
    () => clearTimeout(openTimer),
    unsubEditor,
    unsubDecorations,
    unsubProject,
    unsubExtraRoots,
    unsubExcludes,
    unsubContentRoots,
    () => contentRoots.forEach((d) => d()),
    disposeRoots,
    unsubRoots,
    registerToolWindow({
      id: "project",
      title: "Project",
      icon: "toolwindow-project",
      anchor: "left",
      order: 0,
      component: ProjectView,
      headerActions: ProjectHeaderActions,
      headerMenu: useProjectHeaderMenu,
      titleMenu: useProjectTitleMenu,
    }),
    registerOverlay({ id: "project.fileRefactor", component: FileRefactorDialogHost }),
    registerOverlay({ id: "project.refactoringPreview", component: RefactoringPreviewHost }),
    registerOverlay({ id: "project.newPopup", component: NewPopupHost }),
    registerProjectActions(),
    provideProjectViewSelection(() =>
      selectedNodes()
        .filter((n) => !n.group)
        .map((n) => n.path),
    ),
    onIdeEvent("fsChanged", (e) => void applyFsChange(e)),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    initProjectTree(null);
  };
}
