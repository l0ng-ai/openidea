/** Actions of the project view (Find Action, keymap, other features via `executeAction`). */
import { activeEditor } from "@/editor/api";
import { getAction, registerActions, type Action } from "@/platform/actions";
import { dirname, useProject } from "@/platform/project";
import { showContextMenu, type MenuItem } from "@/ui";
import { maybeEditorService, menuGroupItems, toolWindowService } from "@/workbench/contributions";
import { OPTION_LABELS, SORT_LABELS } from "./HeaderActions";
import { newMenuItems, revealLabel } from "./contextMenu";
import { openNewPopup } from "./newPopupModel";
import type { ProjectNode } from "./model";
import {
  beginNew,
  beginRename,
  copyPaths,
  copySelection,
  delegate,
  deleteSelection,
  findFileUsages,
  folderOf,
  leadNode,
  openCopyDialog,
  openMoveDialog,
  openRenameDialog,
  openSelection,
  paste,
  reloadFromDisk,
  revealInFinder,
  selectedNodes,
  type PathKind,
} from "./operations";
import { nameOf, parentOf } from "./paths";
import { showFilePathPopup } from "./filePath";
import { showNewPopup, treeHandle } from "./ProjectView";
import { lastFileRefactoring, undoFileRefactoring } from "./fileRefactor";
import {
  VIEW_MODES,
  collapseAll,
  currentModel,
  expandAll,
  modeShows,
  reloadAll,
  revealPath,
  setViewMode,
  setViewOption,
  useProjectTree,
} from "./store";
import { tx } from "@/platform/i18n";

const FOCUS = "projectViewFocus";
const OPEN = "projectOpen";

/** Nodes for an action: paths passed as the argument, else the tree selection. */
function nodesFrom(arg: unknown): ProjectNode[] {
  const paths = typeof arg === "string" ? [arg] : Array.isArray(arg) ? arg.filter((p) => typeof p === "string") : null;
  if (!paths) return selectedNodes();
  const model = currentModel();
  return paths.map((p) => {
    const key = model.keyOfPath.get(p);
    const n = key ? model.byKey.get(key) : undefined;
    if (n && n.path === p) return n;
    const dir = useProjectTree.getState().listings.has(p);
    return {
      key: p,
      path: p,
      chain: [p],
      label: nameOf(p),
      dir,
      root: p === useProjectTree.getState().root,
      entry: null,
      ignored: false,
      excluded: false,
      symlink: false,
    };
  });
}

function folderFrom(arg: unknown): string | null {
  if (typeof arg === "string") return useProjectTree.getState().listings.has(arg) ? arg : parentOf(arg);
  return folderOf(leadNode());
}

function showProjectView(focus: boolean) {
  try {
    toolWindowService().show("project", focus);
  } catch {
    /* tool window service not available (tests) */
  }
}

/** Selects `path` (default: the active editor's file) in the project view. */
export function selectInProjectView(path?: string | null, focus = true) {
  const target = path ?? maybeEditorService()?.activePath() ?? null;
  if (!target) return false;
  if (!modeShows(target)) setViewMode("project");
  showProjectView(focus);
  return revealPath(target, focus);
}

/**
 * Select In (⌥F1): a chooser of the places that can show `path` (default: the
 * active editor's file): the project view, contributed targets (`selectIn`
 * menu groups), the navigation bar, Finder / Explorer and the terminal.
 */
export function selectInTargets(path: string): MenuItem[] {
  return [
    { kind: "header", label: "Select In" },
    { label: "Project View", icon: "toolwindow-project", run: () => void selectInProjectView(path) },
    ...menuGroupItems("selectIn", { paths: [path] }),
    ...(getAction("navigate.navigationBar") && maybeEditorService()?.activePath() === path
      ? [{ kind: "action" as const, action: "navigate.navigationBar", label: "Navigation Bar" }]
      : []),
    { label: revealLabel(), icon: "external-link", run: () => void revealInFinder(nodesFrom(path)) },
    ...(getAction("terminal.openAt")
      ? [{ label: "Terminal", icon: "terminal", run: () => void delegate("terminal.openAt", parentOf(path)) }]
      : []),
  ];
}

/**
 * The New popup for the active editor's directory, at the caret (centred near
 * the top without one); `orRoot` falls back to the project root without a file.
 */
export function showNewPopupForEditor(orRoot = false): boolean {
  const editor = activeEditor();
  const path = editor && !editor.ctx.virtual ? editor.ctx.path : null;
  const directory = path ? dirname(path) : orRoot ? (useProject.getState().project?.root ?? null) : null;
  if (!directory) return false;
  const coords = path ? editor!.view.coordsAtPos(editor!.view.state.selection.main.head) : null;
  const at = coords
    ? { x: coords.left, y: coords.bottom + 2 }
    : { x: window.innerWidth / 2 - 140, y: window.innerHeight / 5 };
  openNewPopup(at, newMenuItems(directory, { outsideTree: true }));
  return true;
}

function showSelectIn(path: string) {
  // At the caret, like IDEA's popup; centred near the top otherwise.
  const view = activeEditor()?.view;
  const coords = view && activeEditor()?.ctx.path === path ? view.coordsAtPos(view.state.selection.main.head) : null;
  const at = coords ? { x: coords.left, y: coords.bottom + 2 } : { x: window.innerWidth / 2 - 100, y: 80 };
  showContextMenu(at, selectInTargets(path));
}

export function registerProjectActions(): () => void {
  const copyPath = (kind: PathKind, id: string, title: string): Action => ({
    id,
    title,
    category: "Project View",
    when: OPEN,
    keywords: ["path", "clipboard"],
    run: ({ arg }) => copyPaths(kind, nodesFrom(arg)),
  });

  const toggles: Action[] = OPTION_LABELS.map(([key, label]) => ({
    id: `project.option.${key}`,
    title: tx`Project View: ${label}`,
    category: "View",
    keywords: ["project", "tree", "toggle"],
    toggled: () => useProjectTree.getState().options[key],
    run: () => setViewOption(key, !useProjectTree.getState().options[key]),
  }));

  const modes: Action[] = VIEW_MODES.map(([mode, label]) => ({
    id: `project.viewMode.${mode}`,
    title: tx`Project View: Show ${label}`,
    category: "View",
    when: OPEN,
    keywords: ["project", "pane", "scope", "view as"],
    run: () => {
      setViewMode(mode);
      showProjectView(false);
    },
  }));

  const sorts: Action[] = SORT_LABELS.map(([sortBy, label]) => ({
    id: `project.sortBy.${sortBy}`,
    title: tx`Project View: ${label}`,
    category: "View",
    keywords: ["project", "tree", "sort", "order"],
    toggled: () => useProjectTree.getState().options.sortBy === sortBy,
    run: () => setViewOption("sortBy", sortBy),
  }));

  return registerActions([
    {
      // A path argument (links, breadcrumbs, Open In › Project View) selects it in the project view.
      id: "navigate.selectIn",
      title: "Select In…",
      category: "Navigate",
      when: OPEN,
      keywords: ["locate", "reveal", "show in"],
      run: ({ arg }) => {
        const path = typeof arg === "string" ? arg : (arg as { path?: string } | undefined)?.path;
        if (path) return void selectInProjectView(path);
        const target = maybeEditorService()?.activePath() ?? leadNode()?.path;
        if (target) showSelectIn(target);
      },
    },
    {
      id: "navigate.selectInProjectView",
      title: "Select in Project View",
      category: "Navigate",
      icon: "locate",
      when: OPEN,
      keywords: ["locate", "reveal", "scroll from source", "select opened file"],
      run: ({ arg }) => void selectInProjectView(typeof arg === "string" ? arg : null),
    },
    {
      id: "project.reveal",
      title: "Reveal in Project View",
      category: "Project View",
      hidden: true,
      when: OPEN,
      run: ({ arg }) => void selectInProjectView(typeof arg === "string" ? arg : null, false),
    },
    {
      id: "project.newFile",
      title: "New File",
      category: "File",
      icon: "file",
      when: OPEN,
      keywords: ["create"],
      run: ({ arg, ctx }) => {
        // ⌘N inside the project view opens the New popup (File, Directory, templates);
        // in an editor (where Generate does not apply) it opens for the file's directory.
        if (arg === undefined && ctx[FOCUS] && showNewPopup()) return;
        if (arg === undefined && ctx.editorFocus && showNewPopupForEditor()) return;
        // No focus request: the inline editor takes focus itself.
        showProjectView(false);
        return beginNew("file", folderFrom(arg));
      },
    },
    {
      // IDEA's NewElementSamePlace: the New popup for the current file's directory, wherever the focus is.
      id: "project.newInThisDirectory",
      title: "New in This Directory…",
      category: "File",
      icon: "plus",
      when: OPEN,
      keywords: ["create", "file", "same place", "current directory"],
      run: ({ ctx }) => {
        if (ctx[FOCUS] && showNewPopup()) return;
        showNewPopupForEditor(true);
      },
    },
    {
      // File › New (native menu, VS Code preset): same as New File at the selection.
      id: "file.new",
      title: "New…",
      category: "File",
      hidden: true,
      when: OPEN,
      run: ({ arg }) => {
        showProjectView(false);
        return beginNew("file", folderFrom(arg));
      },
    },
    {
      id: "project.newFolder",
      title: "New Directory",
      category: "File",
      icon: "folder",
      when: OPEN,
      keywords: ["create", "folder", "directory"],
      run: ({ arg }) => {
        // No focus request: the inline editor takes focus itself.
        showProjectView(false);
        return beginNew("dir", folderFrom(arg));
      },
    },
    {
      id: "project.open",
      title: "Jump to Source",
      category: "Project View",
      when: FOCUS,
      run: openSelection,
    },
    {
      id: "project.rename",
      title: "Rename File…",
      category: "Project View",
      icon: "edit",
      // Also from editor tabs and Find Action (the active file); ⇧F6 only in the project view.
      when: OPEN,
      keyWhen: FOCUS,
      keywords: ["refactor"],
      run: ({ arg, ctx }) => {
        if (arg !== undefined) return openRenameDialog(nodesFrom(arg)[0] ?? null);
        const active = ctx[FOCUS] ? null : (maybeEditorService()?.activePath() ?? null);
        return openRenameDialog(active ? (nodesFrom(active)[0] ?? null) : leadNode());
      },
    },
    {
      id: "project.renameInline",
      title: "Rename File Inline",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: () => beginRename(),
    },
    {
      id: "project.move",
      title: "Move File…",
      category: "Project View",
      when: FOCUS,
      keywords: ["refactor", "package"],
      run: ({ arg }) => openMoveDialog(nodesFrom(arg)),
    },
    {
      id: "project.undoMove",
      title: "Undo Move / Rename",
      category: "Project View",
      when: OPEN,
      keywords: ["refactor", "undo"],
      description: "Reverts the last file move or rename and its reference updates",
      run: () => {
        if (lastFileRefactoring()) void undoFileRefactoring();
      },
    },
    {
      id: "project.delete",
      title: "Delete…",
      category: "Project View",
      icon: "trash",
      when: FOCUS,
      // Not while speed search (a popup) owns ⌫.
      keyWhen: "!popupOpen",
      keywords: ["remove", "trash"],
      run: ({ arg }) => deleteSelection(nodesFrom(arg)),
    },
    {
      // F5 (CopyElement): the Copy dialog for the selection, or for the file in the editor.
      id: "project.copyElement",
      title: "Copy…",
      category: "Project View",
      icon: "copy",
      when: OPEN,
      keyWhen: `${FOCUS} || editorFocus`,
      keywords: ["copy file", "duplicate file", "clone"],
      run: ({ arg, ctx }) => {
        if (arg !== undefined || ctx.projectViewFocus) return openCopyDialog(nodesFrom(arg));
        const path = activeEditor()?.ctx.path;
        if (path) openCopyDialog(nodesFrom(path));
      },
    },
    {
      id: "navigate.showFilePath",
      title: "File Path",
      category: "Navigate",
      when: OPEN,
      keywords: ["reveal in finder", "show in explorer", "path popup"],
      run: ({ arg, ctx }) => {
        const node = typeof arg === "string" || ctx.projectViewFocus ? nodesFrom(arg)[0] : undefined;
        const path = node?.path ?? activeEditor()?.ctx.path;
        if (path) showFilePathPopup(path, node?.dir ?? false);
      },
    },
    { id: "project.copy", title: "Copy", category: "Project View", when: FOCUS, run: () => copySelection(false) },
    { id: "project.cut", title: "Cut", category: "Project View", when: FOCUS, run: () => copySelection(true) },
    { id: "project.paste", title: "Paste", category: "Project View", when: FOCUS, run: () => paste() },
    {
      id: "project.copyPath",
      title: "Copy Path",
      category: "Project View",
      when: OPEN,
      hidden: true,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { kind?: PathKind; paths?: string[] };
        return copyPaths(a.kind ?? "absolute", nodesFrom(a.paths));
      },
    },
    copyPath("absolute", "project.copyAbsolutePath", "Copy Absolute Path"),
    copyPath("relative", "project.copyRelativePath", "Copy Path From Content Root"),
    copyPath("name", "project.copyFileName", "Copy File Name"),
    {
      id: "project.revealInFinder",
      title: tx`Reveal in ${revealLabel()}`,
      category: "Project View",
      icon: "external-link",
      when: OPEN,
      keywords: ["show in explorer", "open in finder"],
      run: ({ arg }) => revealInFinder(nodesFrom(arg)),
    },
    {
      id: "project.openInTerminal",
      title: "Open in Terminal",
      category: "Project View",
      icon: "terminal",
      when: OPEN,
      run: ({ arg }) => {
        const dir = folderFrom(arg);
        if (dir) delegate("terminal.openAt", dir);
      },
    },
    {
      id: "project.findInFolder",
      title: "Find in Folder…",
      category: "Project View",
      icon: "search",
      when: OPEN,
      run: ({ arg }) => {
        const dir = folderFrom(arg);
        if (dir) delegate("find.inPath", { directory: dir });
      },
    },
    {
      id: "project.showHistory",
      title: "Local History: Show History",
      category: "Project View",
      icon: "history",
      when: OPEN,
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node) delegate("vcs.localHistory", node.path);
      },
    },
    {
      id: "project.findUsages",
      title: "Find Usages of File",
      category: "Project View",
      when: FOCUS,
      keywords: ["references", "imports"],
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node && !node.dir) void findFileUsages(node.path);
      },
    },
    {
      id: "project.reformatCode",
      title: "Reformat File",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node && !node.dir) delegate("code.reformatFile", { path: node.path });
      },
    },
    {
      id: "project.optimizeImports",
      title: "Optimize Imports in File",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node && !node.dir) delegate("code.optimizeImportsFile", { path: node.path });
      },
    },
    {
      id: "project.compareWith",
      title: "Compare With…",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: ({ arg }) => {
        const files = nodesFrom(arg).filter((n) => !n.dir);
        if (files.length === 2)
          delegate(
            "diff.compareFiles",
            files.map((f) => f.path),
          );
        else if (files[0]) delegate("diff.compareWith", files[0].path);
      },
    },
    {
      id: "project.reloadFromDisk",
      title: "Reload from Disk",
      category: "Project View",
      icon: "refresh",
      when: OPEN,
      keyWhen: FOCUS,
      keywords: ["synchronize", "refresh"],
      run: ({ arg }) => reloadFromDisk(nodesFrom(arg)),
    },
    {
      id: "project.expandAll",
      title: "Expand All",
      category: "Project View",
      icon: "expand-all",
      when: OPEN,
      keyWhen: FOCUS,
      run: () => {
        const lead = leadNode();
        return expandAll(lead?.dir && !lead.root ? lead.key : undefined);
      },
    },
    {
      id: "project.collapseAll",
      title: "Collapse All",
      category: "Project View",
      icon: "collapse-all",
      when: OPEN,
      keyWhen: FOCUS,
      run: () => {
        collapseAll();
        treeHandle.current?.focus();
      },
    },
    {
      id: "project.refresh",
      title: "Reload Project Tree from Disk",
      category: "File",
      icon: "refresh",
      when: OPEN,
      keywords: ["synchronize", "refresh"],
      run: reloadAll,
    },
    ...toggles,
    ...modes,
    ...sorts,
  ]);
}
