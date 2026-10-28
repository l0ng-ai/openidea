/** Context menu and "New" popup of the project view. */
import { executeAction, getAction } from "@/platform/actions";
import { formatBinding, hostBinding, isMacHost, shortcutLabel } from "@/platform/keymap";
import { relativePath, useProject } from "@/platform/project";
import { currentDetectedRoots, currentRoots } from "@/platform/projectRoots";
import type { MenuItem } from "@/ui";
import { menuGroupItems, toolWindowService, type MenuGroupContext } from "@/workbench/contributions";
import type { FolderRole } from "@/platform/languageSettings";
import { directoryRole, markDirectory } from "./markDirectory";
import type { ProjectNode } from "./model";
import { packageKindAt } from "./packages";
import {
  beginNew,
  beginNewPackage,
  canPaste,
  copyPaths,
  copySelection,
  delegate,
  deleteSelection,
  findFileUsages,
  folderOf,
  openCopyDialog,
  openFile,
  openMoveDialog,
  openRenameDialog,
  paste,
  reloadFromDisk,
  revealInFinder,
  vcsArg,
} from "./operations";
import { isSameOrInside } from "./paths";
import { tx } from "@/platform/i18n";

/** Keys handled by the project view itself (the default keymap has no entries for them). */
export const LOCAL_KEYS: Record<string, string> = {
  "project.newMenu": "Meta+N",
  "project.rename": "Shift+F6",
  "project.move": "F6",
  "project.delete": "Delete",
  "project.copy": "Meta+C",
  "project.cut": "Meta+X",
  "project.paste": "Meta+V",
  "project.copyAbsolutePath": "Meta+Shift+C",
  "project.open": "F4",
};

export const keyLabel = (id: string) =>
  shortcutLabel(id) ?? (LOCAL_KEYS[id] ? formatBinding(hostBinding(LOCAL_KEYS[id])) : undefined);

/**
 * New › items for `parent`. `outsideTree` (⌘N in the editor): File asks for the
 * name in a dialog, and the inline Directory / Package editors bring up the project view.
 */
export function newMenuItems(parent: string | null, { outsideTree = false } = {}): MenuItem[] {
  const root = useProject.getState().project?.root;
  const rel = parent && root ? (parent === root ? "" : relativePath(root, parent)) : null;
  const pkg = rel === null ? null : packageKindAt(rel, currentRoots(), currentDetectedRoots());
  const inline = (start: () => Promise<void>) => () => {
    if (outsideTree) showProjectView();
    void start();
  };
  const emptyFile = outsideTree && parent && getAction("templates.new.file");
  const dir: MenuItem = {
    id: "new.dir",
    label: "Directory",
    icon: "folder",
    run: inline(() => beginNew("dir", parent)),
  };
  return [
    emptyFile
      ? {
          id: "new.file",
          label: "File",
          icon: "file",
          run: () => void executeAction(emptyFile.id, { directory: parent }),
        }
      : { id: "new.file", label: "File", icon: "file", run: inline(() => beginNew("file", parent)) },
    // IDEA offers "Package" instead of "Directory" inside a Java / Kotlin source root.
    pkg === "jvm"
      ? { id: "new.package", label: "Package", icon: "package", run: inline(() => beginNewPackage("jvm", parent)) }
      : dir,
    ...(pkg === "python"
      ? [
          {
            id: "new.pythonPackage",
            label: "Python Package",
            icon: "package",
            run: inline(() => beginNewPackage("python", parent)),
          },
        ]
      : []),
    ...contributedNewItems(parent),
  ];
}

function showProjectView() {
  try {
    toolWindowService().show("project", false);
  } catch {
    /* tool window service not available (tests) */
  }
}

/** File kinds contributed to the `new` menu group (templates, HTTP Request, Scratch File…). */
function contributedNewItems(parent: string | null): MenuItem[] {
  const items = menuGroupItems("new", parent ? { paths: [parent], dirs: [true] } : { paths: [] });
  return items.length ? [{ kind: "separator" }, ...items] : [];
}

/** An item bound to another feature's action (resolved by the menu: hidden when missing, disabled when off). */
function act(action: string, arg?: unknown, label?: string): MenuItem | null {
  return getAction(action) ? { kind: "action", action, arg, label } : null;
}

/** Runs another feature's action directly (the project view decides availability), with its shortcut. */
function delegated(
  id: string,
  arg: unknown,
  label: string,
  extra: { icon?: string; shortcut?: string } = {},
): MenuItem | null {
  if (!getAction(id)) return null;
  return { id, label, ...extra, shortcut: extra.shortcut ?? shortcutLabel(id), run: () => void delegate(id, arg) };
}

type Entry = MenuItem | null | false | undefined;

/** A submenu of the present entries, or nothing when none is left (never an empty submenu). */
function submenu(id: string, label: string, entries: Entry[], icon?: string): MenuItem | null {
  const items = entries.filter((i): i is MenuItem => !!i);
  if (!items.some((i) => i.kind !== "separator" && i.kind !== "header")) return null;
  return { id, label, icon, submenu: items };
}

/**
 * IDEA's ProjectViewPopupMenu: New / clipboard / find / Refactor / edit /
 * Run group / Open In / Local History / Git / Compare / Mark Directory as.
 * Items that cannot apply to the selection are hidden (or disabled, like IDEA's
 * clipboard group), so the project root and Scratches get a shorter menu.
 */
export function contextMenuItems(nodes: ProjectNode[]): MenuItem[] {
  if (nodes.some((n) => n.readOnly)) return libraryMenuItems(nodes.filter((n) => !n.group));
  const lead = nodes[0] ?? null;
  const single = nodes.length === 1 ? lead : null;
  const nonRoot = nodes.filter((n) => !n.root);
  const folder = folderOf(lead);
  const files = nodes.filter((n) => !n.dir);
  const singleFile = single && !single.dir ? single : null;
  const project = useProject.getState().project;
  // Scratches and other contributed roots live outside the project: no VCS, roots or LSP usages.
  const inProject = !!project && nodes.every((n) => isSameOrInside(n.path, project.root));
  const items: MenuItem[] = [];
  const push = (...list: Entry[]) => list.forEach((i) => i && items.push(i));

  push({ id: "new", label: "New", submenu: newMenuItems(folder) }, { kind: "separator" });

  // Cut / Copy / Copy Path/Reference… / Paste
  push(
    {
      id: "cut",
      label: "Cut",
      icon: "cut",
      shortcut: keyLabel("project.cut"),
      disabled: !nonRoot.length,
      run: () => copySelection(true),
    },
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      shortcut: keyLabel("project.copy"),
      disabled: !nonRoot.length,
      run: () => copySelection(false),
    },
    {
      id: "copyPath",
      label: "Copy Path/Reference…",
      submenu: [
        {
          id: "abs",
          label: "Absolute Path",
          shortcut: keyLabel("project.copyAbsolutePath"),
          run: () => void copyPaths("absolute", nodes),
        },
        { id: "name", label: "File Name", run: () => void copyPaths("name", nodes) },
        { id: "rel", label: "Path From Content Root", run: () => void copyPaths("relative", nodes) },
      ],
    },
    {
      id: "paste",
      label: "Paste",
      icon: "paste",
      shortcut: keyLabel("project.paste"),
      disabled: !canPaste(),
      run: () => void paste(folder),
    },
    { kind: "separator" },
  );

  // Jump to Source / Find Usages / Find in Files… / Replace in Files…
  push(
    files.length > 0 && {
      id: "jumpToSource",
      label: "Jump to Source",
      icon: "edit",
      shortcut: keyLabel("project.open"),
      run: () => files.forEach((f) => void openFile(f.path)),
    },
    inProject &&
      singleFile && {
        id: "findUsages",
        label: "Find Usages",
        shortcut: keyLabel("project.findUsages"),
        run: () => void findFileUsages(singleFile.path),
      },
    !!folder && delegated("find.inPath", { directory: folder }, "Find in Files…", { icon: "search" }),
    !!folder && delegated("find.replaceInPath", { directory: folder }, "Replace in Files…"),
    { kind: "separator" },
  );

  // Refactor ›
  push(
    submenu("refactor", "Refactor", [
      single &&
        !single.root && {
          id: "rename",
          label: "Rename…",
          shortcut: keyLabel("project.rename"),
          run: () => void openRenameDialog(single),
        },
      nonRoot.length > 0 && {
        id: "move",
        label: nonRoot.length === 1 ? (nonRoot[0]!.dir ? "Move Directory…" : "Move File…") : "Move…",
        shortcut: keyLabel("project.move"),
        run: () => openMoveDialog(nonRoot),
      },
      nonRoot.length > 0 && {
        id: "copy",
        label: nonRoot.length === 1 ? (nonRoot[0]!.dir ? "Copy Directory…" : "Copy File…") : "Copy…",
        shortcut: keyLabel("project.copyElement"),
        run: () => openCopyDialog(nonRoot),
      },
      nonRoot.length > 0 && { kind: "separator" },
      nonRoot.length > 0 && {
        id: "safeDelete",
        label: "Safe Delete…",
        shortcut: formatBinding(isMacHost() ? "Meta+Backspace" : "Delete"),
        run: () => void deleteSelection(nodes),
      },
    ]),
    { kind: "separator" },
  );

  // Reformat Code / Optimize Imports / Delete…
  push(
    singleFile &&
      getAction("code.reformatFile") && {
        id: "reformat",
        label: "Reformat Code",
        shortcut: keyLabel("project.reformatCode"),
        run: () => void delegate("code.reformatFile", { path: singleFile.path }),
      },
    singleFile &&
      getAction("code.optimizeImportsFile") && {
        id: "optimizeImports",
        label: "Optimize Imports",
        shortcut: keyLabel("project.optimizeImports"),
        run: () => void delegate("code.optimizeImportsFile", { path: singleFile.path }),
      },
    {
      id: "delete",
      label: "Delete…",
      shortcut: keyLabel("project.delete"),
      disabled: !nonRoot.length,
      run: () => void deleteSelection(nodes),
    },
    { kind: "separator" },
  );

  // Contributed groups (Run / Debug '…', More Run/Debug ›), each followed by a separator.
  push(...menuGroupItems("projectView", menuGroupContext(nodes)));

  // Open In ›
  push(
    submenu("openIn", "Open In", [
      { id: "finder", label: revealLabel(), icon: "external-link", run: () => void revealInFinder(nodes) },
      folder && getAction("terminal.openAt")
        ? { id: "terminal", label: "Terminal", icon: "terminal", run: () => void delegate("terminal.openAt", folder) }
        : null,
      { kind: "separator" },
      ...menuGroupItems("openIn", menuGroupContext(nodes)),
    ]),
    { kind: "separator" },
  );

  // Local History › / Reload from Disk
  push(
    single &&
      submenu("history", "Local History", [
        delegated("vcs.localHistory", single.path, "Show History"),
        delegated("localHistory.putLabel", undefined, "Put Label…"),
      ]),
    {
      id: "reload",
      label: "Reload from Disk",
      icon: "refresh",
      shortcut: keyLabel("project.reloadFromDisk"),
      run: () => void reloadFromDisk(nodes),
    },
    { kind: "separator" },
  );

  // Git ›
  if (inProject && project?.isGit) {
    const arg = vcsArg(nodes);
    const dirs = nodes.some((n) => n.dir);
    push(
      submenu(
        "git",
        "Git",
        [
          act("vcs.commit", undefined, dirs || nodes.length > 1 ? "Commit…" : "Commit File…"),
          act("vcs.addToVcs", arg, "Add"),
          { kind: "separator" },
          singleFile && act("vcs.annotate", singleFile.path, "Annotate with Git Blame"),
          act("vcs.showDiff", arg, "Show Diff"),
          singleFile && act("vcs.compareWithBranch", { path: singleFile.path }, "Compare with Branch…"),
          singleFile && act("vcs.showHistory", [singleFile.path], "Show History"),
          act("vcs.rollback", arg, "Rollback…"),
          { kind: "separator" },
          act("vcs.push", undefined, "Push…"),
          act("vcs.update", undefined, "Pull…"),
          act("vcs.fetch", undefined, "Fetch"),
          { kind: "separator" },
          act("vcs.branches", undefined, "Branches…"),
          act("vcs.newBranch", undefined, "New Branch…"),
          act("vcs.newTag", undefined, "New Tag…"),
          act("vcs.resetHead", undefined, "Reset HEAD…"),
          { kind: "separator" },
          act("vcs.stash", undefined, "Stash Changes…"),
          act("vcs.unstash", undefined, "Unstash Changes…"),
        ],
        "branch",
      ),
      { kind: "separator" },
    );
  }

  // IDEA: Compare With… (one file) / Compare Files (two files).
  if (files.length === 2 && nodes.length === 2)
    push(
      delegated(
        "diff.compareFiles",
        files.map((f) => f.path),
        "Compare Files",
        { icon: "diff" },
      ),
    );
  else if (singleFile)
    push(
      delegated("diff.compareWith", singleFile.path, "Compare With…", {
        icon: "diff",
        shortcut: keyLabel("project.compareWith"),
      }),
    );

  if (inProject && single?.dir && !single.root && !single.placeholder) {
    const current = directoryRole(single.path);
    const roles: Array<[FolderRole, string, string]> = [
      ["source", "Sources Root", "folder-source"],
      ["test", "Test Sources Root", "folder-test"],
      ["resources", "Resources Root", "folder-resources"],
      ["testResources", "Test Resources Root", "folder-test-resources"],
      ["excluded", "Excluded", "folder-excluded"],
    ];
    push({
      id: "markAs",
      label: "Mark Directory as",
      submenu: [
        ...roles
          .filter(([role]) => role !== current)
          .map(([role, label, icon]) => ({ id: role, label, icon, run: () => void markDirectory(single.path, role) })),
        ...(current
          ? [
              {
                id: "unmark",
                label:
                  current === "excluded" ? "Cancel Exclusion" : tx`Unmark as ${roles.find(([r]) => r === current)![1]}`,
                run: () => void markDirectory(single.path, null),
              },
            ]
          : []),
      ],
    });
  }
  return items;
}

/** Library sources (External Libraries) are read-only: copy, find and reveal only. */
function libraryMenuItems(nodes: ProjectNode[]): MenuItem[] {
  if (!nodes.length) return [];
  const single = nodes.length === 1 ? nodes[0]! : null;
  const folder = single?.dir ? single.path : null;
  const items: Entry[] = [
    { id: "copy", label: "Copy", icon: "copy", shortcut: keyLabel("project.copy"), run: () => copySelection(false) },
    {
      id: "copyPath",
      label: "Copy Path/Reference…",
      submenu: [
        {
          id: "abs",
          label: "Absolute Path",
          shortcut: keyLabel("project.copyAbsolutePath"),
          run: () => void copyPaths("absolute", nodes),
        },
        { id: "name", label: "File Name", run: () => void copyPaths("name", nodes) },
      ],
    },
    { kind: "separator" },
    !!folder && delegated("find.inPath", { directory: folder }, "Find in Files…", { icon: "search" }),
    !!folder && { kind: "separator" },
    submenu("openIn", "Open In", [
      { id: "finder", label: revealLabel(), icon: "external-link", run: () => void revealInFinder(nodes) },
    ]),
    single &&
      !single.dir &&
      delegated("diff.compareWith", single.path, "Compare With…", {
        icon: "diff",
        shortcut: keyLabel("project.compareWith"),
      }),
  ];
  return items.filter((i): i is MenuItem => !!i);
}

export function revealLabel() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Win/i.test(ua)) return "Explorer";
  if (/Linux/i.test(ua)) return "Files";
  return "Finder";
}

/** What contributed menu groups see: the selected (non-placeholder) paths. */
export function menuGroupContext(nodes: ProjectNode[]): MenuGroupContext {
  const real = nodes.filter((n) => !n.placeholder);
  return { paths: real.map((n) => n.path), dirs: real.map((n) => n.dir) };
}
