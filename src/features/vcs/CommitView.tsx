/**
 * Commit tool window: change list with inclusion checkboxes, message, stashes. Its
 * parts also make the Git window's Local Changes / Stash tabs and the Commit dialog.
 */
import { writeClipboardText } from "@/platform/clipboard";
import { formatDateTime } from "@/platform/dateFormat";
import { useWorkflowSettings, workflowSettings } from "@/platform/workflowSettings";
import { formatBinding, isMacHost, macStroke, normalizeBinding, shortcutLabel, strokeOf } from "@/platform/keymap";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { tx, txPart, txTemplate } from "@/platform/i18n";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { fontWeightOf } from "@/platform/editorSettings";
import { resolveMonoFont } from "@/platform/fonts";
import { basename, dirname, useProject } from "@/platform/project";
import { isTestFile, useEffectiveRoots } from "@/platform/projectRoots";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Tree,
  fileIconName,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  tooltipAttrs,
  type MenuItem,
  type TabItem,
  type TreeHandle,
  T,
} from "@/ui";
import {
  editorService,
  maybeEditorService,
  menuGroupItems,
  type EditorInput,
  useMenuSlotItems,
} from "@/workbench/contributions";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import {
  aggregateCheck,
  buildChangeTree,
  changeFileNodes,
  checkOf,
  filesOf,
  groupOf,
  ignoreTargets,
  commitsStagedPart,
  planCommit,
  stagingPatchEntries,
  toggledCheck,
  type ChangeNode,
} from "./changes";
import { amendPreviewNode } from "./amendPreview";
import { AmendTargetMenu } from "./AmendTargetMenu";
import { commitChanges, deleteFiles } from "./changeOps";
import { CommitOptionsPopup } from "./CommitOptions";
import { CommitCheckSummary } from "./CommitCheckSummary";
import { DEFAULT_LIST_NAME, useChangelists, withListDefaults } from "./changelists";
import {
  bulkStagePaths,
  inclusionChecks,
  isCommitAll,
  ROLLBACK_UNSTAGED,
  STAGE_ALL_TRACKED,
  STAGE_WITHOUT_CONTENT,
  STASH_SILENTLY,
  TOGGLE_STAGED_REPOSITORIES,
  stagingAreaOn,
  stashableRoots,
  statusForCommit,
  unstagedSelection,
  unstagingPaths,
  useStagingArea,
  useStagedRepositoryScope,
} from "./staging";
import { SHOW_THREE_SIDE_DIFF } from "./stagingVersions";
import { addToChangelist, commitFiles } from "./changelistsUi";
import { acceptConflictSide, canRevertResolved } from "./conflictsUi";
import {
  messageHistory,
  pendingFixup,
  setAmend,
  setCommitDiffPreview,
  setDiffPreview,
  setGroupByDir,
  setGroupByRepo,
  setGroupByStaging,
  setShowUnversionedSeparately,
  showsIgnoredFiles,
  useCommit,
  type CommitTab,
} from "./commitStore";
import { pushAfterCommit } from "./commitUi";
import { rebaseAfterFixup } from "./rebase";
import { stashTabOf, stashTabs, type ContentTab } from "./gitTabs";
import {
  DIFF_KIND,
  changeNodeDiff,
  changeNodeDiffData,
  changeTreeDiffData,
  diffInput,
  openDiff,
  openVcsDiff,
  opensDiffOnActivate,
  workingDiffData,
} from "./diffInput";
import { DiffEditor } from "./DiffEditor";
import { KIND_COLOR, KIND_LABEL, fileCount, stripSlash } from "./model";
import { call, commands } from "@/platform/ipc";
import type { FileStatus } from "@/bindings";
import { OperationBanner } from "./operations";
import { runOp } from "./ops";
import { ShelfPanel, loadShelves, useShelf } from "./shelf";
import { existsOnDisk, refreshNow, useVcs } from "./store";
import { StashesPanel } from "./StashesPanel";
import { saveVcsSetting } from "./settingsUi";
import { TOGGLE_IGNORED_FILES, useIgnoredFiles } from "./ignoredFiles";
import styles from "./CommitView.module.css";

/** MIME type of files dragged onto a change list (absolute paths, newline-separated). */
const CHANGES_MIME = "application/x-openidea-changes";

/** Shown text of a node: group names are translated, except the names of user change lists. */
function nodeText(n: ChangeNode): string {
  if (n.group === "amend" && n.historicalFileCount !== undefined) return n.label;
  return n.type === "group" && (!n.changelist || n.label === DEFAULT_LIST_NAME) ? tx(n.label) : n.label;
}

/** Content tabs as `Tabs` items, with their counts. */
export function tabItems(tabs: readonly ContentTab[]): TabItem[] {
  return tabs.map((t) => ({
    id: t.id,
    label: t.label,
    // `Tabs` treats a missing flag as closable once it has `onClose`.
    closable: !!t.closable,
    trailing: t.count ? <span className={styles.count}>{t.count}</span> : undefined,
  }));
}

/** Shelf and stash counts for the tabs (loads the shelves once VCS is available). */
export function useStashTabCounts(available: boolean) {
  const roots = useVcs((s) => s.roots);
  const version = useVcs((s) => s.version);
  const [stashCount, setStashCount] = useState(0);
  useEffect(() => {
    let live = true;
    if (available)
      void Promise.all(roots.map((r) => call(commands.vcsStashes(r))))
        .then((lists) => live && setStashCount(lists.reduce((n, list) => n + list.length, 0)))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [available, roots, version]);
  const shelfCount = useShelf((s) => s.shelves.length);
  useEffect(() => {
    if (available) void loadShelves().catch(() => undefined);
  }, [available]);
  return { stashCount: available ? stashCount : 0, shelfCount };
}

/** "Commit" / "Shelf" / "Stash" content tabs; they stand in for the tool window title. */
export function CommitTabs() {
  const available = useVcs((s) => s.available);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = useCommit((s) => s.tab);
  const counts = useStashTabCounts(available);
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      activeId={stashTabOf(tab, combine)}
      onSelect={(id) => useCommit.setState({ tab: id as CommitTab })}
      aria-label="Commit"
      items={tabItems([
        { id: "changes", label: "Commit" },
        ...(available ? stashTabs({ combine, tab, ...counts }) : []),
      ])}
    />
  );
}

export function CommitToolWindow() {
  const available = useVcs((s) => s.available);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = stashTabOf(
    useCommit((s) => s.tab),
    combine,
  );
  if (!available)
    return (
      <EmptyState icon="commit" title="Version control is not configured">
        <T>Open a Git repository to commit changes.</T>
      </EmptyState>
    );
  return <div className={styles.root}>{tab === "changes" ? <ChangesPanel /> : <StashContent tab={tab} />}</div>;
}

/** The Shelf, Stash or combined "Stashes and Shelves" tab. */
export function StashContent({ tab, toolWindow = "commit" }: { tab: CommitTab; toolWindow?: "commit" | "git" }) {
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const anchor = useToolWindowLayout(
    (s) => s.placements[toolWindow]?.anchor ?? (toolWindow === "git" ? "bottom" : "left"),
  );
  const orientation = anchor === "bottom" ? "horizontal" : "vertical";
  if (combine)
    return (
      <SplitGroup orientation="vertical" className={styles.split} storageKey="openidea.vcs.stashShelfSplit">
        <SplitPanel id="stashes" defaultSize="50%" minSize="80px">
          <StashesPanel orientation={orientation} />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="shelf" defaultSize="50%" minSize="80px">
          <ShelfPanel />
        </SplitPanel>
      </SplitGroup>
    );
  return tab === "shelf" ? <ShelfPanel /> : <StashesPanel orientation={orientation} />;
}

// ---------------------------------------------------------------------------

const bottomLeft = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2 };
};

/**
 * Activates a change (Enter, double-click, Show Diff); F7 continues through the other
 * files of its group, in tree order (Enter and double-click: of the whole tree, on into the
 * unversioned files, as IDEA's Commit diff preview). Enter and double-click follow IDEA's Show on
 * Double-Click (opensDiffOnActivate): the source file, or the diff where the commit
 * interface puts it (openVcsDiff: a preview editor tab, or under the modal interface the
 * front diff window, behind the modal Commit dialog, #1863). `forceDiff` is Show Diff and
 * the Commit dialog's own activation, which always show the diff in front.
 */
function openNode(n: ChangeNode, roots: readonly ChangeNode[], forceDiff = false) {
  if (n.type !== "file" || !n.path) return;
  if (n.group === "ignored" || (!forceDiff && !n.historicalDiff && !opensDiffOnActivate())) {
    jumpToChangeSource(n);
    return;
  }
  void openVcsDiff((forceDiff || n.historicalDiff ? changeNodeDiffData : changeTreeDiffData)(roots, n), {
    preview: true,
  });
}

const ignoredDirectory = (node: ChangeNode) =>
  node.group === "ignored" && node.type === "file" && node.files[0]?.relPath.endsWith("/");

function ignoredFileCount(files: readonly FileStatus[]): string {
  const folders = files.filter((file) => file.relPath.endsWith("/")).length;
  const count = files.length - folders;
  const entries = count ? [fileCount(count)] : [];
  if (folders) entries.push(folders === 1 ? tx`${folders} folder` : tx`${folders} folders`);
  return entries.join(" · ");
}

function jumpToChangeSource(node: ChangeNode) {
  if (!node.path || node.kind === "deleted") return;
  if (ignoredDirectory(node)) void executeAction("project.revealInFinder", node.path);
  else if (node.group === "staged") void executeAction("vcs.showStagedVersion", node.path);
  else void editorService().openFile(node.path, { focus: true });
}

/** The setting behind Show on Double-Click (`None` follows the commit interface). */
export const DOUBLE_CLICK_KEY = "vcs.commit.doubleClickOpensDiff";

/**
 * IDEA's Show on Double-Click: the change lists' View Options items. An unset value
 * (Follow the Interface) is written as `null`, which removes the key from the settings.
 */
export function doubleClickMenu(value: boolean | null | undefined): MenuItem[] {
  const on = value ?? null;
  const set = (v: boolean | null) => () => void saveVcsSetting(DOUBLE_CLICK_KEY, v);
  return [
    { kind: "separator" },
    {
      label: tx("Show on Double-Click"),
      submenu: [
        { label: tx("Follow the Interface"), checked: on === null, run: set(null) },
        { kind: "separator" },
        { label: tx("Diff"), checked: on === true, run: set(true) },
        { label: tx("Source"), checked: on === false, run: set(false) },
      ],
    },
  ];
}

/** Context menu of a change list's header: the list's own actions, then the bulk ones on its files. */
export function listMenu(id: string, active: boolean, files: readonly FileStatus[]): MenuItem[] {
  const paths = files.map((f) => stripSlash(f.path));
  const unstage = unstagingPaths(files.filter((f) => f.staged));
  const count = paths.length;
  return [
    ...(count ? [{ kind: "action" as const, action: "vcs.changelist.commit", arg: id, label: "Commit…" }] : []),
    { kind: "separator" },
    { kind: "action", action: "vcs.changelist.new" },
    { kind: "action", action: "vcs.changelist.edit", arg: id },
    ...(active
      ? []
      : [
          { kind: "action" as const, action: "vcs.changelist.setActive", arg: id },
          { kind: "action" as const, action: "vcs.changelist.delete", arg: id },
        ]),
    { kind: "separator" },
    // The whole list's files, as IDEA offers on a change list's header and as file
    // and directory nodes below it already offer (issue #473).
    { kind: "action", action: "vcs.rollback", arg: paths, label: "Rollback…", disabled: !count },
    {
      label: "Stage",
      icon: "plus",
      disabled: !files.some((f) => f.unstaged),
      run: () => void runOp(tx`Stage ${count} files`, () => call(commands.vcsStage(paths))),
    },
    {
      label: "Unstage",
      icon: "minus",
      disabled: !unstage.length,
      run: () => void runOp(tx`Unstage ${count} files`, () => call(commands.vcsUnstage(unstage))),
    },
    { kind: "separator" },
    ...(count
      ? [
          { kind: "action" as const, action: "vcs.shelve", arg: paths },
          { kind: "action" as const, action: "vcs.createPatch", arg: paths },
        ]
      : []),
  ];
}

/** Paths Delete… applies to: only when every selected file is unversioned (versioned ones are rolled back). */
/** The selected files that still exist in the working tree (Delete… removes them from disk). */
/** Whether the change leaves the file in the working tree. */
const onDisk = existsOnDisk;

export function deletableFiles(nodes: ChangeNode[]): string[] {
  const files = filesOf(nodes);
  return files.length && files.every(onDisk) ? files.map((f) => f.path) : [];
}

/**
 * Copies the selected files' absolute paths (`absolute`) or just their names
 * (`name`) to the clipboard, one per line: Ctrl+C / Ctrl+Shift+C of the changes
 * tree and the context menu's Copy items (#1877).
 */
export function copyChangePaths(nodes: ChangeNode[], kind: "absolute" | "name") {
  const text = filesOf(nodes)
    .map((f) => (kind === "name" ? basename(f.path) : f.path))
    .join("\n");
  if (text) void writeClipboardText(text);
}

export function nodeMenu(
  nodes: ChangeNode[],
  repos: readonly string[],
  opts?: { roots?: readonly ChangeNode[] },
): MenuItem[] {
  const staging = stagingAreaOn();
  const files = filesOf(nodes);
  const deletable = deletableFiles(nodes);
  const paths = files.map((f) => f.path);
  const patchSelection = staging ? { staging: stagingPatchEntries(nodes) } : paths;
  const canExportPatch = !("staging" in patchSelection) || patchSelection.staging.length > 0;
  const first = nodes.find((n) => n.type === "file");
  if (nodes[0]?.group === "amend") {
    const file = first ?? changeFileNodes(nodes)[0];
    if (!file) return [];
    const data = opts?.roots ? changeNodeDiffData(opts.roots, file) : changeNodeDiff(file);
    return [
      { label: "Show Diff", icon: "diff", shortcut: shortcutLabel("vcs.showDiff"), run: () => openVcsDiff(data) },
      { kind: "action", action: "vcs.showDiffInNewWindow", arg: data },
    ];
  }
  if (nodes.some((node) => node.group === "ignored")) {
    const items: MenuItem[] = [];
    if (first?.path) {
      items.push(
        ignoredDirectory(first)
          ? { kind: "action", action: "project.revealInFinder", arg: first.path }
          : { label: "Jump to Source", icon: "external-link", run: () => jumpToChangeSource(first) },
      );
    }
    if (deletable.length) {
      items.push({ label: "Delete…", icon: "trash", run: () => void deleteFiles(deletable) });
    }
    items.push(
      { label: "Copy Path", icon: "copy", run: () => copyChangePaths(nodes, "absolute") },
      { label: "Copy File Name", icon: "copy", run: () => copyChangePaths(nodes, "name") },
    );
    return items;
  }
  const untracked = files.filter((f) => f.unstaged === "untracked");
  const toIgnore = ignoreTargets(nodes, repos);
  const conflicted = files.filter((f) => f.unstaged === "conflicted");
  const rollbackPaths = staging ? unstagedSelection(nodes).map((file) => file.path) : paths;
  const stageFiles = (
    staging ? filesOf(nodes.filter((node) => node.group === "unstaged" || node.group === "unversioned")) : files
  ).filter((file) => file.unstaged);
  const unstageFiles = (staging ? filesOf(nodes.filter((node) => node.group === "staged")) : files).filter(
    (file) => file.staged,
  );
  const rollback: MenuItem[] = rollbackPaths.length
    ? [
        {
          kind: "action",
          action: staging ? ROLLBACK_UNSTAGED : "vcs.rollback",
          arg: rollbackPaths,
          label: "Rollback…",
        },
      ]
    : [];
  const stash: MenuItem = { kind: "action", action: "vcs.stashSelected", arg: paths, disabled: !paths.length };
  const stageActions: MenuItem[] = [
    {
      label: "Stage",
      icon: "plus",
      // Under Staged Changes, a partially staged file only offers Unstage.
      disabled: !stageFiles.length || nodes.every((n) => n.group === "staged"),
      run: () =>
        void runOp(tx`Stage ${stageFiles.length} files`, () =>
          call(commands.vcsStage(stageFiles.map((file) => file.path))),
        ),
    },
    ...(staging && untracked.length
      ? [{ kind: "action" as const, action: STAGE_WITHOUT_CONTENT, arg: untracked.map((file) => file.path) }]
      : []),
    {
      label: "Unstage",
      icon: "minus",
      disabled: !unstageFiles.length || nodes.every((n) => n.group === "unstaged" || n.group === "unversioned"),
      run: () =>
        void runOp(tx`Unstage ${unstageFiles.length} files`, () =>
          call(commands.vcsUnstage(unstagingPaths(unstageFiles))),
        ),
    },
  ];
  const fileActions: MenuItem[] = [
    ...(untracked.length
      ? [{ kind: "action" as const, action: "vcs.addToVcs", arg: untracked.map((f) => f.path) }]
      : []),
    ...(deletable.length
      ? [
          {
            label: "Delete…",
            icon: "trash",
            shortcut: formatBinding(isMacHost() ? "Backspace" : "Delete"),
            run: () => void deleteFiles(deletable),
          },
        ]
      : []),
    ...(toIgnore.length
      ? [
          {
            label: "Add to .gitignore",
            submenu: [
              { kind: "action" as const, action: "vcs.ignoreShared", arg: toIgnore, label: ".gitignore" },
              { kind: "action" as const, action: "vcs.ignoreLocal", arg: toIgnore, label: ".git/info/exclude" },
            ],
          },
        ]
      : []),
  ];
  // The staging menu operates on the index. A change list can commit or move individual files.
  const primary: MenuItem[] = staging
    ? [...stageActions, stash, ...rollback, ...fileActions]
    : [
        {
          label: "Commit File…",
          icon: "commit",
          disabled: !files.some((f) => groupOf(f) === "changes"),
          run: () => commitFiles(paths),
        },
        ...rollback,
        ...(nodes.some((n) => n.changelist)
          ? [
              {
                kind: "action" as const,
                action: "vcs.changelist.move",
                arg: paths,
                label: "Move to Another Changelist…",
              },
            ]
          : []),
      ];
  const contributed = menuGroupItems("changes", {
    paths: files.filter(onDisk).map((f) => stripSlash(f.path)),
  });
  return [
    ...(canRevertResolved(paths) ? [{ kind: "action" as const, action: "vcs.revertResolved", arg: paths }] : []),
    ...(conflicted.length
      ? [
          { kind: "action" as const, action: "vcs.resolveConflicts", label: "Resolve Conflicts…" },
          {
            label: "Accept Theirs",
            run: () =>
              void acceptConflictSide(
                conflicted.map((file) => file.path),
                "theirs",
              ),
          },
          {
            label: "Accept Yours",
            run: () =>
              void acceptConflictSide(
                conflicted.map((file) => file.path),
                "ours",
              ),
          },
          { kind: "separator" as const },
        ]
      : []),
    ...primary,
    { kind: "separator" },
    // The node itself, like double-click: under Staged or Unstaged its side of the index.
    opts?.roots && first
      ? {
          label: "Show Diff",
          icon: "diff",
          shortcut: shortcutLabel("vcs.showDiff"),
          // An explicit Show Diff always opens the diff, whatever Show on Double-Click says.
          run: () => openNode(first, opts.roots!, true),
        }
      : { kind: "action", action: "vcs.showDiff", arg: first?.path },
    {
      kind: "action",
      action: "vcs.showDiffInNewWindow",
      arg: first?.path ? (opts?.roots ? changeNodeDiffData(opts.roots, first) : changeNodeDiff(first)) : undefined,
      disabled: !first?.path,
    },
    ...(staging && files.some((file) => file.unstaged !== "ignored" && file.staged !== "ignored")
      ? [{ kind: "action" as const, action: SHOW_THREE_SIDE_DIFF, arg: paths }]
      : []),
    {
      label: "Jump to Source",
      icon: "external-link",
      shortcut: "F4",
      disabled: !first?.path || first.kind === "deleted",
      run: () => first && jumpToChangeSource(first),
    },
    { label: "Copy Path", icon: "copy", run: () => copyChangePaths(nodes, "absolute") },
    { label: "Copy File Name", icon: "copy", run: () => copyChangePaths(nodes, "name") },
    ...(staging ? [] : [{ kind: "separator" as const }, ...fileActions, ...stageActions]),
    { kind: "separator" },
    ...(canExportPatch ? [{ kind: "action" as const, action: "vcs.createPatch", arg: patchSelection }] : []),
    ...(canExportPatch ? [{ kind: "action" as const, action: "vcs.copyPatch", arg: patchSelection }] : []),
    { kind: "action", action: "vcs.shelve", arg: paths },
    ...(staging ? [] : [stash]),
    { kind: "separator" },
    {
      label: "Show History",
      icon: "history",
      disabled: !first?.path,
      run: () => void executeAction("vcs.showLog", { path: first?.path }),
    },
    { kind: "action", action: "vcs.localHistory", arg: first?.path },
    { kind: "action", action: "vcs.annotate", arg: first?.path },
    ...(contributed.length ? [{ kind: "separator" as const }, ...contributed] : []),
  ];
}

/**
 * The staging operation of a node of the staging area's tree: Unstage under Staged, Stage
 * under Unstaged and Unversioned Files, applied to every file below the node.
 */
export function stageOperation(n: ChangeNode): { label: string; icon: "plus" | "minus"; paths: string[] } | null {
  const paths = n.files.map((f) => stripSlash(f.path));
  if (!paths.length) return null;
  if (n.group === "staged") return { label: "Unstage", icon: "minus", paths: unstagingPaths(n.files) };
  if (n.group === "unstaged" || n.group === "unversioned") return { label: "Stage", icon: "plus", paths };
  return null;
}

function StageButton({ node }: { node: ChangeNode }) {
  const op = stageOperation(node);
  if (!op) return null;
  const { label, icon, paths } = op;
  const count = node.files.length;
  return (
    <IconButton
      icon={icon}
      title={label}
      size="small"
      className={styles.stageButton}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void runOp(icon === "plus" ? tx`Stage ${count} files` : tx`Unstage ${count} files`, () =>
          call(icon === "plus" ? commands.vcsStage(paths) : commands.vcsUnstage(paths)),
        ).then(() => refreshNow());
      }}
    />
  );
}

function CheckMark({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      className={clsx(styles.check, (checked || indeterminate) && styles.checkOn)}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {indeterminate ? <Icon name="minus" size={10} /> : checked ? <Icon name="check" size={10} /> : null}
    </span>
  );
}

/** Inclusion state of every change (user overrides over the change list defaults). */
function useCommitChecks() {
  const status = useVcs((s) => s.status);
  const root = useVcs((s) => s.root) ?? "";
  const userChecks = useCommit((s) => s.checks);
  const lists = useChangelists((s) => s.state);
  const staging = useStagingArea();
  const allowCommitAll = useWorkflowSettings((s) => s.vcs.commit.commitAllWhenNothingStaged);
  return useMemo(
    () => inclusionChecks(status, root, lists, userChecks, staging, allowCommitAll),
    [status, root, lists, userChecks, staging, allowCommitAll],
  );
}

/** Number of changes the commit would include. */
export function useIncludedCount(): number {
  const status = useVcs((s) => s.status);
  const roots = useVcs((s) => s.roots);
  const scope = useStagedRepositoryScope();
  const excluded = useCommit((s) => s.excludedStagedRepos);
  const checks = useCommitChecks();
  const includeByDefault = useWorkflowSettings((s) => s.vcs.commit.includeChangesByDefault);
  return useMemo(
    () => planCommit(statusForCommit(status, roots, scope, excluded), checks, includeByDefault).included.length,
    [status, roots, scope, excluded, checks, includeByDefault],
  );
}

/**
 * The Commit tool window's Commit tab: changes with inclusion checkboxes above the
 * message, with an optional embedded preview of the selected file's diff beside them
 * (issue #1599).
 */
function ChangesPanel() {
  const included = useIncludedCount();
  const preview = useCommit((s) => s.commitDiffPreview);
  const path = useCommit((s) => (s.selection.length === 1 ? s.selection[0] : null));
  const selectionKey = useCommit((s) => (s.selectionKeys.length === 1 ? s.selectionKeys[0] : null));
  const amend = useCommit((s) => (s.amend ? s.amendPreview : null));
  const groupByDir = useCommit((s) => s.groupByDir);
  const repos = useVcs((s) => s.roots);
  const headId = useVcs((s) => amend && s.heads[amend.root]?.headCommit);
  const amended = useMemo(() => amendPreviewNode(amend, groupByDir, repos, headId), [amend, groupByDir, repos, headId]);
  const historical =
    amended && selectionKey?.startsWith("amend:")
      ? changeFileNodes([amended]).find((node) => node.key === selectionKey)?.historicalDiff
      : undefined;
  const data = historical ?? (path ? workingDiffData(path) : null);
  const hasChanges = useVcs((s) => s.status.length > 0) || !!amended?.historicalFileCount;
  return (
    <SplitGroup
      orientation="horizontal"
      className={styles.split}
      storageKey={preview ? "openidea.vcs.commitPreviewSplit" : undefined}
    >
      <SplitPanel id="commit" defaultSize="62%" minSize="20%">
        <SplitGroup orientation="vertical" className={styles.split} storageKey="openidea.vcs.commitMessageSplit">
          <SplitPanel id="changes" defaultSize="62%" minSize="20%">
            <ChangesTree mode="commit" amended={amended} />
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="message" defaultSize="38%" minSize="120px">
            <CommitPanel included={included} />
          </SplitPanel>
        </SplitGroup>
      </SplitPanel>
      {preview && (
        <>
          <SplitHandle />
          <SplitPanel id="preview" defaultSize="38%" minSize="120px">
            {data ? (
              <DiffEditor input={diffInput(data)} />
            ) : (
              <EmptyState>
                <T>{hasChanges ? "Select a file to preview its changes" : "No changes to preview"}</T>
              </EmptyState>
            )}
          </SplitPanel>
        </>
      )}
    </SplitGroup>
  );
}

/**
 * The Git window's Local Changes tab: a diff preview beside the tree when
 * bottom-docked, below it when side-docked (off via View Options › Show Diff Preview).
 */
export function LocalChangesView() {
  const preview = useCommit((s) => s.diffPreview);
  const path = useCommit((s) => (s.selection.length === 1 ? s.selection[0] : null));
  const anchor = useToolWindowLayout((s) => s.placements.git?.anchor ?? "bottom");
  return (
    <SplitGroup
      orientation={anchor === "bottom" ? "horizontal" : "vertical"}
      className={styles.split}
      storageKey={
        preview ? `openidea.vcs.localChangesSplit.${anchor === "bottom" ? "horizontal" : "vertical"}` : undefined
      }
    >
      <SplitPanel id="changes" defaultSize="50%" minSize="20%">
        <ChangesTree mode="local" />
      </SplitPanel>
      {preview && (
        <>
          <SplitHandle />
          <SplitPanel id="preview" defaultSize="50%" minSize="120px">
            {path ? (
              <DiffEditor input={diffInput(workingDiffData(path))} />
            ) : (
              <EmptyState>
                <T>Select a file to preview its changes</T>
              </EmptyState>
            )}
          </SplitPanel>
        </>
      )}
    </SplitGroup>
  );
}

/**
 * The change tree with its toolbar. `commit`: the Commit tool window's (inclusion
 * checkboxes); `local`: the Git tool window's Local Changes tab of the modal commit
 * interface (no checkboxes, a Commit… button); `dialog`: the Commit dialog's.
 */
export function ChangesTree({ mode, amended }: { mode: "commit" | "local" | "dialog"; amended?: ChangeNode | null }) {
  const status = useVcs((s) => s.status);
  const root = useVcs((s) => s.root) ?? "";
  const groupByDir = useCommit((s) => s.groupByDir);
  // With the staging area the Commit tool window shows the index: Staged / Unstaged, no lists or checkboxes.
  const staging = useStagingArea() && mode === "commit";
  const stageScope = useStagedRepositoryScope();
  const excludedStagedRepos = useCommit((s) => s.excludedStagedRepos);
  const showIgnored = useCommit((s) => showsIgnoredFiles(root, s.ignoredVisibility));
  const ignored = useIgnoredFiles(root, staging && showIgnored);
  const groupByStaging = useCommit((s) => s.groupByStaging) || staging;
  const groupByRepo = useCommit((s) => s.groupByRepo);
  const showUnversionedSeparately = useCommit((s) => s.showUnversionedSeparately);
  const diffPreview = useCommit((s) => s.diffPreview);
  const commitDiffPreview = useCommit((s) => s.commitDiffPreview);
  const doubleClickOpensDiff = useWorkflowSettings((s) => s.vcs.commit.doubleClickOpensDiff);
  const changelists = useChangelists((s) => s.state);
  const lists = staging ? undefined : changelists;
  const checks = useCommitChecks();
  const includeByDefault = useWorkflowSettings((s) => s.vcs.commit.includeChangesByDefault);
  const checkboxes = mode !== "local" && !staging;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["group:unversioned", "group:ignored"]));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const treeRef = useRef<TreeHandle>(null);
  const viewRef = useRef<HTMLButtonElement>(null);

  const repos = useVcs((s) => s.roots);
  const heads = useVcs((s) => s.heads);
  const projectRoots = useEffectiveRoots();
  const roots = useMemo(() => {
    const changes = buildChangeTree(
      status,
      root,
      groupByDir,
      lists,
      repos,
      groupByStaging,
      heads,
      groupByRepo,
      showUnversionedSeparately,
      ignored?.files,
    );
    return amended ? [amended, ...changes] : changes;
  }, [
    status,
    root,
    groupByDir,
    lists,
    repos,
    groupByStaging,
    heads,
    groupByRepo,
    showUnversionedSeparately,
    ignored,
    amended,
  ]);
  const [byKey, parents] = useMemo(() => {
    const m = new Map<string, ChangeNode>();
    const up = new Map<string, string>();
    const walk = (ns: ChangeNode[], parent?: string) =>
      ns.forEach((n) => {
        m.set(n.key, n);
        if (parent) up.set(n.key, parent);
        if (n.children) walk(n.children, n.key);
      });
    walk(roots);
    return [m, up] as const;
  }, [roots]);

  const [nodeToReveal, setNodeToReveal] = useState<{ key: string } | null>(null);
  const revealNode = useCallback(
    (node: ChangeNode) => {
      const ancestors = new Set<string>();
      for (let key = parents.get(node.key); key; key = parents.get(key)) ancestors.add(key);
      setCollapsed((current) => new Set([...current].filter((key) => !ancestors.has(key))));
      setNodeToReveal({ key: node.key });
    },
    [parents],
  );

  const followedDiff = useRef<string | null>(null);
  useEffect(() => {
    const editor = maybeEditorService();
    const followDiff = (input: EditorInput | null) => {
      if (input?.kind !== DIFF_KIND) {
        followedDiff.current = null;
        return;
      }
      if (input.key === followedDiff.current) return;
      const node = [...byKey.values()].find((node) => {
        if (node.type !== "file" || node.path !== input.path) return false;
        return diffInput(changeNodeDiff(node)).key === input.key;
      });
      if (node) {
        followedDiff.current = input.key;
        revealNode(node);
      } else {
        followedDiff.current = null;
      }
    };
    followDiff(editor?.activeInput?.() ?? null);
    return editor?.onActiveInputChange?.(followDiff);
  }, [byKey, revealNode]);

  // While the active tab shows one of this tree's diffs, a single selected file replaces it,
  // keeping focus in the tree (a click or arrow key walks the changes).
  const followSelection = (nodes: readonly ChangeNode[]) => {
    const node = nodes.length === 1 ? nodes[0] : undefined;
    if (mode === "dialog" || node?.type !== "file" || node.group === "ignored" || !node.path) return;
    const active = maybeEditorService()?.activeInput?.();
    if (active?.kind !== DIFF_KIND || active.key !== followedDiff.current) return;
    if (diffInput(changeNodeDiff(node)).key === active.key) return;
    void openDiff((node.historicalDiff ? changeNodeDiffData : changeTreeDiffData)(roots, node), {
      preview: true,
      focus: false,
    });
  };

  // Reveal only after the ancestors have expanded, without moving keyboard focus.
  useLayoutEffect(() => {
    if (nodeToReveal) treeRef.current?.reveal(nodeToReveal.key);
  }, [nodeToReveal]);

  const selectOpened = () => {
    const path = editorService().activePath();
    const node = path ? [...byKey.values()].find((node) => node.type === "file" && node.path === path) : undefined;
    if (node) revealNode(node);
  };
  const expanded = useMemo(() => {
    const s = new Set<string>();
    for (const k of byKey.keys()) if (!collapsed.has(k)) s.add(k);
    return s;
  }, [byKey, collapsed]);

  // Forget overrides for files that are no longer changed.
  useEffect(() => {
    const live = new Set(status.map((f) => f.path));
    const cur = useCommit.getState().checks;
    if ([...cur.keys()].some((k) => !live.has(k))) {
      useCommit.setState({ checks: new Map([...cur].filter(([k]) => live.has(k))) });
    }
  }, [status]);

  const toggle = useCallback((nodes: ChangeNode[]) => {
    const files = filesOf(nodes);
    const { status: st, root: r } = useVcs.getState();
    const cur = withListDefaults(st, r ?? "", useChangelists.getState().state, useCommit.getState().checks);
    const includeByDefault = workflowSettings().vcs.commit.includeChangesByDefault;
    const agg = aggregateCheck(files, cur, includeByDefault);
    const target = agg.on === files.length && !agg.indeterminate ? "none" : "all";
    const next = new Map(cur);
    for (const f of files)
      next.set(f.path, files.length === 1 ? toggledCheck(checkOf(f, cur, includeByDefault)) : target);
    useCommit.setState({ checks: next });
  }, []);

  const selectedNodes = () => [...selected].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);
  const stagedRepository = (node: ChangeNode) =>
    staging && node.group === "staged" && node.repository && stageScope?.has(node.repository) ? node.repository : null;
  const rollbackPaths = staging ? unstagedSelection(selectedNodes()).map((file) => file.path) : undefined;

  return (
    <div className={styles.changes}>
      <div className={clsx(styles.toolbar, styles.changesToolbar)} role="toolbar" aria-label={tx("Changes")}>
        <div className={styles.changesTools}>
          <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshNow()} />
          {staging && (
            <IconButton
              icon="plus"
              action={STAGE_ALL_TRACKED}
              disabled={!bulkStagePaths(status, false).length}
              size="small"
            />
          )}
          {mode === "local" && <IconButton icon="commit" action="vcs.commit" size="small" />}
          <IconButton
            icon="undo"
            action={staging ? ROLLBACK_UNSTAGED : "vcs.rollback"}
            actionArg={rollbackPaths}
            disabled={rollbackPaths?.length === 0}
            size="small"
          />
          {mode === "local" && <IconButton icon="changelist" action="vcs.changelist.new" size="small" />}
          {mode !== "dialog" && <IconButton icon="shelve" action="vcs.shelveSilently" size="small" />}
          {mode !== "dialog" && staging && (
            <IconButton
              icon="stash"
              action={STASH_SILENTLY}
              disabled={!stashableRoots(status, repos).length}
              size="small"
            />
          )}
          {mode !== "dialog" && <IconButton icon="git-pull" action="vcs.update" size="small" />}
          <IconButton
            ref={viewRef}
            icon="eye"
            title="View Options"
            size="small"
            aria-haspopup="menu"
            onClick={() =>
              viewRef.current &&
              showContextMenu(bottomLeft(viewRef.current), [
                { kind: "header", label: "Group By" },
                { label: "Directory", checked: groupByDir, run: () => setGroupByDir(!groupByDir) },
                // IDEA offers it once the project has several repositories.
                ...(repos.length > 1
                  ? [{ label: "Repository", checked: groupByRepo, run: () => setGroupByRepo(!groupByRepo) }]
                  : []),
                ...(staging
                  ? []
                  : [
                      {
                        label: "Staging State",
                        checked: groupByStaging,
                        run: () => setGroupByStaging(!groupByStaging),
                      },
                    ]),
                { kind: "separator" },
                {
                  label: "Show Unversioned Files Separately",
                  checked: showUnversionedSeparately,
                  run: () => setShowUnversionedSeparately(!showUnversionedSeparately),
                },
                ...(staging ? [{ kind: "action" as const, action: TOGGLE_IGNORED_FILES, checked: showIgnored }] : []),
                ...(mode === "local"
                  ? [
                      { kind: "separator" } as const,
                      { label: "Show Diff Preview", checked: diffPreview, run: () => setDiffPreview(!diffPreview) },
                    ]
                  : []),
                // Not in the Commit dialog, whose files always open as source.
                ...(mode === "dialog" ? [] : doubleClickMenu(doubleClickOpensDiff)),
              ])
            }
          />
          {/* WebStorm's Preview Diff: an embedded diff of the selection beside the changes (#1599). */}
          {mode === "commit" && (
            <IconButton
              icon="editor-preview"
              title="Preview Diff"
              size="small"
              pressed={commitDiffPreview}
              onClick={() => setCommitDiffPreview(!commitDiffPreview)}
            />
          )}
        </div>
        <div className={styles.changesTools}>
          {mode !== "dialog" && (
            <IconButton icon="locate" title="Select Opened File" size="small" onClick={selectOpened} />
          )}
          <IconButton icon="expand-all" title="Expand All" size="small" onClick={() => setCollapsed(new Set())} />
          <IconButton
            icon="collapse-all"
            title="Collapse All"
            size="small"
            onClick={() =>
              setCollapsed(new Set([...byKey.values()].filter((n) => n.type !== "file").map((n) => n.key)))
            }
          />
        </div>
      </div>
      {mode !== "dialog" && <OperationBanner />}
      {ignored?.failed && (
        <span role="status" className={styles.empty}>
          <T>Could not load ignored files</T>
        </span>
      )}
      <div
        className={styles.treeWrap}
        data-changes-tree={mode}
        onKeyDownCapture={(e) => {
          if (checkboxes && e.key === " " && !e.metaKey && !e.ctrlKey && selected.size) {
            const nodes = selectedNodes().filter((node) => node.group !== "amend");
            if (!nodes.length) return;
            e.preventDefault();
            e.stopPropagation();
            toggle(nodes);
          } else if (
            staging &&
            stageScope &&
            e.key === " " &&
            !e.metaKey &&
            !e.ctrlKey &&
            selected.size &&
            !(e.target instanceof HTMLInputElement)
          ) {
            const repos = selectedNodes()
              .map(stagedRepository)
              .filter((repo) => repo !== null);
            if (!repos.length) return;
            e.preventDefault();
            e.stopPropagation();
            void executeAction(TOGGLE_STAGED_REPOSITORIES, repos);
          } else if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey) {
            const nodes = selectedNodes();
            const group = nodes.find((x) => x.type === "group" && x.changelist);
            const deletable = group ? [] : deletableFiles(nodes);
            if (group?.changelist) {
              e.preventDefault();
              e.stopPropagation();
              void executeAction("vcs.changelist.delete", group.changelist);
            } else if (deletable.length) {
              e.preventDefault();
              e.stopPropagation();
              void deleteFiles(deletable);
            }
          } else {
            // IDEA: Ctrl+C copies the file names, Ctrl+Shift+C the absolute paths (#1877).
            const stroke = strokeOf(e.nativeEvent);
            const copy = stroke && normalizeBinding(macStroke(stroke));
            if (copy === "Meta+C" || copy === "Shift+Meta+C") {
              e.preventDefault();
              e.stopPropagation();
              copyChangePaths(selectedNodes(), copy === "Meta+C" ? "name" : "absolute");
            }
          }
        }}
      >
        <Tree<ChangeNode>
          handleRef={treeRef}
          roots={roots}
          getKey={(n) => n.key}
          getLabel={nodeText}
          getDirectory={(n) => (n.path && n.type !== "group" ? (n.type === "dir" ? n.path : dirname(n.path)) : null)}
          getChildren={(n) => n.children}
          rowClassName={(n) =>
            n.type !== "group" && n.path && isTestFile(n.path, projectRoots) ? styles.testFile : undefined
          }
          isExpandable={(n) => n.type !== "file" && (n.group !== "amend" || !!n.children?.length)}
          expanded={expanded}
          onExpandedChange={(_next, node, open) =>
            setCollapsed((c) => {
              const s = new Set(c);
              if (open) s.delete(node.key);
              else s.add(node.key);
              return s;
            })
          }
          selected={selected}
          onSelectionChange={(sel) => {
            setSelected(sel);
            const nodes = [...sel].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);
            useCommit.setState({
              selection: filesOf(nodes.filter((n) => n.group !== "ignored")).map((f) => f.path),
              selectionKeys: [...sel],
              unstagedSelection: unstagedSelection(nodes).map((file) => file.path),
              selectedList: nodes.find((n) => n.changelist)?.changelist ?? null,
            });
            followSelection(nodes);
          }}
          onActivate={(n) => openNode(n, roots, mode === "dialog")}
          onJumpToSource={async (n) => {
            if (n.group === "ignored") {
              if (n.type === "file") jumpToChangeSource(n);
              return;
            }
            if (n.type === "group") {
              const files = n.files.filter((f) => onDisk(f) && !f.path.endsWith("/"));
              for (const [i, file] of files.entries()) {
                await editorService().openFile(file.path, { focus: i === files.length - 1 });
              }
              return;
            }
            const file = n.type === "file" ? n : selectedNodes().find((x) => x.type === "file");
            if (file?.path && file.kind !== "deleted") void editorService().openFile(file.path, { focus: true });
          }}
          onContextMenu={(node, sel, e: MouseEvent) => {
            if (!node) return;
            if (node.type === "group" && node.changelist) {
              showContextMenu(e, listMenu(node.changelist, !!node.active, node.files));
              return;
            }
            const nodes = [...sel]
              .map((k) => byKey.get(k))
              .filter((n): n is ChangeNode => !!n && (n.group === "amend") === (node.group === "amend"));
            showContextMenu(e, nodeMenu(nodes.length ? nodes : [node], repos, { roots }));
          }}
          aria-label="Changes"
          empty={
            <span className={styles.empty}>
              <T>No local changes</T>
            </span>
          }
          renderNode={(n, st) => {
            const repo = stagedRepository(n);
            const agg = aggregateCheck(n.files, checks, includeByDefault);
            const label = (
              <span
                className={clsx(
                  styles.label,
                  n.type === "group" && styles.groupLabel,
                  n.type === "group" && n.changelist && !n.active && styles.inactiveList,
                )}
                style={n.type === "file" && n.kind ? { color: KIND_COLOR[n.kind] } : undefined}
                {...(n.type === "file" && n.kind && tooltipAttrs(KIND_LABEL[n.kind]))}
                {...(repo && tooltipAttrs(n.label, undefined, true))}
              >
                {nodeText(n)}
              </span>
            );
            // Pointer-driven (HTML5 drag and drop never reaches the Tauri webview):
            // file and folder rows drag (unversioned ones onto a changelist, which
            // adds them to Git); any row of a changelist takes dropped files into it.
            const list = n.changelist;
            const dnd = {
              ...(list !== undefined && {
                ref: (el: HTMLSpanElement | null) =>
                  el
                    ? registerDropTarget(el, {
                        accepts: (type) => type === CHANGES_MIME,
                        over: () => setDropTarget(list),
                        leave: () => setDropTarget(null),
                        drop: (data) => {
                          setDropTarget(null);
                          void addToChangelist(data.payload.split("\n"), list);
                        },
                      })
                    : undefined,
              }),
              ...(n.type !== "group" &&
                n.group !== "ignored" &&
                n.files.length > 0 && {
                  onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
                    const paths =
                      selected.has(n.key) && selected.size > 1
                        ? filesOf(selectedNodes().filter((node) => node.group !== "ignored")).map((f) => f.path)
                        : n.files.map((f) => f.path);
                    startPointerDrag(e, e.currentTarget, {
                      type: CHANGES_MIME,
                      payload: paths.map(stripSlash).join("\n"),
                    });
                  },
                }),
            };
            return (
              <span
                className={clsx(styles.nodeRow, n.type === "group" && dropTarget === n.changelist && styles.dropTarget)}
                {...dnd}
                {...tooltipAttrs(n.warning)}
              >
                {checkboxes && n.group !== "amend" && (
                  <CheckMark
                    checked={agg.checked}
                    indeterminate={agg.indeterminate}
                    label={tx`Include ${n.type === "group" && (!n.changelist || n.label === DEFAULT_LIST_NAME) ? txPart(n.label) : n.label} in commit`}
                    onToggle={() => toggle(selected.has(n.key) && selected.size > 1 ? selectedNodes() : [n])}
                  />
                )}
                {repo && (
                  <span onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      tabIndex={-1}
                      aria-label={tx`Include ${n.label} in commit`}
                      checked={!excludedStagedRepos.has(repo)}
                      onChange={() => void executeAction(TOGGLE_STAGED_REPOSITORIES, repo)}
                    />
                  </span>
                )}
                {n.type === "group" ? (
                  n.group === "amend" &&
                  (n.historicalFileCount === undefined ? (
                    <Spinner size={14} />
                  ) : (
                    <Icon
                      name={n.warning ? "warning" : "commit"}
                      size={16}
                      label={n.warning ? tx(n.warning) : undefined}
                      className={clsx(styles.icon, n.warning && styles.committerWarning)}
                    />
                  ))
                ) : (
                  <Icon
                    name={
                      n.type === "dir" || ignoredDirectory(n)
                        ? st.expanded
                          ? "folder-open"
                          : "folder"
                        : fileIconName(n.label)
                    }
                    size={16}
                    className={styles.icon}
                  />
                )}
                {label}
                {n.type !== "file" && (n.group !== "amend" || n.historicalFileCount !== undefined) && (
                  <span className={styles.nodeCount}>
                    {n.group === "ignored"
                      ? ignoredFileCount(n.files)
                      : fileCount(n.historicalFileCount ?? n.files.length)}
                  </span>
                )}
                {!staging && n.type === "file" && n.files[0] && commitsStagedPart(n.files[0]) && (
                  <span className={styles.partial} title={tx("Partially staged: only staged hunks are committed")}>
                    <T>partial</T>
                  </span>
                )}
                {n.detail && n.detailIcon && <Icon name={n.detailIcon} size={14} className={styles.detailIcon} />}
                {n.detail && <span className={styles.detail}>{n.detail}</span>}
                {staging && <StageButton node={n} />}
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}

const MISSING_BLANK_LINE = "Missing blank line between subject and body";

/** The quick fix for {@link MISSING_BLANK_LINE}: an empty line after the subject. */
export function addBlankLineAfterSubject(message: string): string {
  const end = message.indexOf("\n");
  return end < 0 ? message : `${message.slice(0, end)}\n${message.slice(end)}`;
}

/** Commit message inspections (Settings › Version Control › Commit). */
export function messageProblems(
  message: string,
  c: {
    blankLineAfterSubject: boolean;
    limitSubject: boolean;
    subjectLimit: number;
    limitBody: boolean;
    bodyLimit: number;
  },
): string[] {
  const lines = message.split("\n");
  const out: string[] = [];
  if (c.limitSubject && (lines[0]?.length ?? 0) > c.subjectLimit)
    out.push(`Subject line is longer than ${c.subjectLimit} characters`);
  if (c.blankLineAfterSubject && lines.length > 1 && lines[1]!.trim() !== "") out.push(MISSING_BLANK_LINE);
  if (c.limitBody) {
    const long = lines.slice(1).findIndex((l) => l.length > c.bodyLimit);
    if (long >= 0) out.push(`Body line ${long + 2} is longer than ${c.bodyLimit} characters`);
  }
  return out;
}

/** "Wrap when typing reaches right margin": breaks the caret line at the last space before `limit`. */
export function wrapAtMargin(text: string, caret: number, limit: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const end = text.indexOf("\n", caret);
  const line = text.slice(start, end < 0 ? text.length : end);
  if (start === 0 || line.length <= limit) return null; // the subject line is never wrapped
  const cut = line.lastIndexOf(" ", limit);
  if (cut <= 0) return null;
  const at = start + cut;
  return { text: `${text.slice(0, at)}\n${text.slice(at + 1)}`, caret };
}

export interface CommitRunner {
  /** Commit was asked for without a message: reported at the field. */
  emptyError: boolean;
  clearEmptyError: () => void;
  /** Whether the Commit buttons are enabled. */
  canCommit: boolean;
  run: (push: boolean, rebaseFixup?: boolean) => Promise<void>;
}

/**
 * Commit / Commit and Push… of the Commit tool window and the Commit dialog: the
 * shared pipeline (`commitChanges`), then the push. `onCommitted` runs after a commit.
 */
export function useCommitRunner(included: number, onCommitted?: () => void): CommitRunner {
  const amend = useCommit((s) => s.amend);
  const merging = useVcs((s) => s.branch?.operation === "merge");
  const [emptyError, setEmptyError] = useState(false);
  const busy = useCommit((s) => !!s.operation);
  const loadingAmend = useCommit((s) => s.amend && s.amendPreview?.status === "loading");
  const scope = useStagedRepositoryScope();
  const excluded = useCommit((s) => s.excludedStagedRepos);
  const hasRepository = !scope || [...scope].some((repo) => !excluded.has(repo));
  const run = async (push: boolean, rebaseFixup = false) => {
    if (useCommit.getState().operation) return;
    const fixup = rebaseFixup ? pendingFixup(useCommit.getState().message, useCommit.getState().fixupTarget) : null;
    const committed = await commitChanges(() => setEmptyError(true), { requireSyncChecks: push || rebaseFixup });
    if (!committed) return;
    onCommitted?.();
    if (fixup && !committed.some((entry) => entry.continuedApply)) void rebaseAfterFixup(fixup);
    else if (push) void pushAfterCommit(committed);
  };
  return {
    emptyError,
    clearEmptyError: () => setEmptyError(false),
    canCommit: hasRepository && (included > 0 || amend || merging) && !busy && !loadingAmend,
    run,
  };
}

/** Amend, message history and the message field with its inspections and failed checks. */
export function CommitMessageField({
  runner,
  chooseAmendTarget,
  onOpenToolWindow,
}: {
  runner: CommitRunner;
  chooseAmendTarget?: boolean;
  onOpenToolWindow?: () => void;
}) {
  const message = useCommit((s) => s.message);
  const amend = useCommit((s) => s.amend);
  const focusTick = useCommit((s) => s.focusTick);
  const ref = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTick = useCommit((s) => s.historyTick);
  const { emptyError } = runner;
  const amendRoot = useVcs((s) => (s.roots.length === 1 ? s.roots[0] : null));

  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);
  // Show Commit Message History (⌃M) asks through the store.
  const [seenHistoryTick, setSeenHistoryTick] = useState(historyTick);
  if (historyTick !== seenHistoryTick) {
    setSeenHistoryTick(historyTick);
    if (messageHistory().length) setHistoryOpen(true);
  }

  const cfg = useWorkflowSettings((s) => s.vcs.commit);
  const editor = useProject((s) => s.settings?.editor);
  const { family, size } = resolveMonoFont(undefined, editor);
  const first = message.split("\n")[0] ?? "";
  const tooLong = cfg.limitSubject && first.length > cfg.subjectLimit;
  const problems = messageProblems(message, cfg).filter((p) => !p.startsWith("Subject line"));
  const margin = cfg.limitBody ? cfg.bodyLimit : cfg.subjectLimit;
  const showMargin = cfg.showRightMargin && (cfg.limitBody || cfg.limitSubject);
  const history = messageHistory();

  return (
    <>
      <div ref={barRef} className={styles.commitBar}>
        <Checkbox checked={amend} onChange={(v) => void setAmend(v)} label="Amend" />
        {chooseAmendTarget && amendRoot && <AmendTargetMenu root={amendRoot} />}
        <IconButton
          icon="history"
          title="Commit Message History"
          size="small"
          disabled={!history.length}
          aria-haspopup="menu"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((o) => !o)}
        />
        <Menu
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          anchor={barRef}
          placement="top-start"
          iconColumn={false}
          aria-label="Recent commit messages"
          items={history.map((m, i) => ({
            id: `h${i}`,
            label: m.split("\n")[0]!.slice(0, 80),
            run: () => {
              useCommit.setState({ message: m });
              ref.current?.focus();
            },
          }))}
        />
        <CommitMessageActions />
        <span className={styles.grow} />
        {tooLong && (
          <span className={clsx(styles.lineLen, styles.lineLenWarn)} title={tx("Subject line length")}>
            {first.length}/{cfg.subjectLimit}
          </span>
        )}
      </div>
      <textarea
        ref={ref}
        data-autofocus
        className={clsx(styles.message, !showMargin && styles.noMargin, emptyError && styles.messageError)}
        aria-invalid={emptyError || undefined}
        style={{
          ["--guide" as string]: `${margin}ch`,
          fontFamily: family,
          fontSize: size,
          fontWeight: fontWeightOf(editor?.fontWeight, 400),
          lineHeight: editor?.lineHeight ? `${editor.lineHeight}px` : undefined,
        }}
        value={message}
        placeholder={tx("Commit Message")}
        aria-label={tx("Commit message")}
        spellCheck
        onChange={(e) => {
          const el = e.target;
          const wrapped =
            cfg.limitBody && cfg.wrapAtMargin ? wrapAtMargin(el.value, el.selectionStart, cfg.bodyLimit) : null;
          useCommit.setState({ message: wrapped?.text ?? el.value });
          runner.clearEmptyError();
          if (wrapped) requestAnimationFrame(() => el.setSelectionRange(wrapped.caret, wrapped.caret));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void runner.run(e.altKey);
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
      />
      {emptyError && (
        <div className={clsx(styles.inspections, styles.inspectionError)} role="alert">
          <T>Specify commit message</T>
        </div>
      )}
      {problems.length > 0 && (
        <div className={styles.inspections} role="status">
          {problems.map((p, i) => (
            <span key={p}>
              {i > 0 && " · "}
              {txTemplate(p)}
              {p === MISSING_BLANK_LINE && (
                <button
                  type="button"
                  className={styles.inspectionFix}
                  onClick={() => {
                    const el = ref.current;
                    const caret = el ? el.selectionStart + (el.selectionStart > first.length ? 1 : 0) : 0;
                    useCommit.setState({ message: addBlankLineAfterSubject(message) });
                    requestAnimationFrame(() => {
                      el?.focus();
                      el?.setSelectionRange(caret, caret);
                    });
                  }}
                >
                  <T>Add blank line</T>
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <CommitCheckFeedback canRun={runner.canCommit} onOpenToolWindow={onOpenToolWindow} />
    </>
  );
}

function CommitCheckFeedback({ canRun, onOpenToolWindow }: { canRun: boolean; onOpenToolWindow?: () => void }) {
  const result = useCommit((s) => s.checkResult);
  const checking = useCommit((s) => s.operation === "check");
  if (checking)
    return (
      <div className={styles.checkProblems}>
        <Spinner label={tx("Running commit checks…")} />
        <span aria-hidden="true">
          <T>Running commit checks…</T>
        </span>
      </div>
    );
  if (!result) return null;
  return (
    <div className={styles.checkFeedback}>
      <CommitCheckSummary result={result} onOpenToolWindow={onOpenToolWindow} />
      <IconButton
        icon="refresh"
        title="Rerun Commit Checks"
        action="vcs.runCommitChecks"
        actionArg="current"
        size="small"
        disabled={!canRun}
      />
    </div>
  );
}

/** Actions contributed above the message (a plugin's `commit.message` menu items). */
function CommitMessageActions() {
  const items = useMenuSlotItems((s) => s.slots.commitMessage);
  useContextKeys();
  return (
    <>
      {(items ?? [])
        .filter((i) => evaluateWhen(i.when ?? undefined))
        .map((i) => (
          <IconButton key={i.action} icon={i.icon ?? "plugin"} action={i.action} actionArg={i.arg} size="small" />
        ))}
    </>
  );
}

/** Label of the Commit button. */
export function commitLabel(amend: boolean, problems: boolean, all = false): string {
  return problems ? "Commit Anyway" : amend ? "Amend Commit" : all ? "Commit All" : "Commit";
}

/** Label of the Commit and Push button. */
export const commitAndPushLabel = (amend: boolean) => (amend ? "Amend and Push…" : "Commit and Push…");

/** The message and the Commit buttons of the Commit tool window. */
function CommitPanel({ included }: { included: number }) {
  const amend = useCommit((s) => s.amend);
  const author = useCommit((s) => s.author.trim());
  const authorDate = useCommit((s) => s.authorDate);
  const remoteBusy = useVcs((s) => s.remoteBusy);
  const blocked = useCommit((s) => !!s.checkResult?.blocked && !s.checkResult.stale);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const authorRef = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState<"options" | "author" | null>(null);
  const runner = useCommitRunner(included);
  const { canCommit } = runner;
  // After Fixup… / Squash Into…, the second button commits and autosquashes the target.
  const fixup = useCommit((s) => pendingFixup(s.message, s.fixupTarget));
  const staging = useStagingArea();
  const allowCommitAll = useWorkflowSettings((s) => s.vcs.commit.commitAllWhenNothingStaged);
  const commitAll = useVcs((s) => staging && allowCommitAll && isCommitAll(s.status));

  return (
    <div className={styles.commit}>
      <CommitMessageField runner={runner} chooseAmendTarget />
      {(author || authorDate) && (
        <div className={styles.commitAuthor}>
          {author && (
            <>
              <T>By</T>
              <button
                type="button"
                ref={authorRef}
                className={clsx(styles.optLink, styles.authorLink)}
                aria-label={tx("Edit Commit Author")}
                aria-haspopup="dialog"
                aria-expanded={optionsOpen === "author"}
                {...tooltipAttrs(author, undefined, true)}
                onClick={() => setOptionsOpen((open) => (open === "author" ? null : "author"))}
              >
                {author.replace(/\s*<[^<>]*>$/, "") || author}
              </button>
            </>
          )}
          {authorDate && (
            <span className={styles.authorDate} {...tooltipAttrs(tx("Author date"), undefined, true)}>
              {formatDateTime(new Date(authorDate))}
            </span>
          )}
        </div>
      )}
      <div className={styles.commitActions}>
        <Button variant="primary" disabled={!canCommit} onClick={() => void runner.run(false)} title="⌘↩">
          <T>{commitLabel(amend, blocked, commitAll)}</T>
        </Button>
        {fixup ? (
          <Button
            className={styles.pushButton}
            disabled={!canCommit}
            onClick={() => void runner.run(false, true)}
            title="Commit and Rebase"
          >
            <span>
              <T>Commit and Rebase</T>
            </span>
          </Button>
        ) : (
          <Button
            className={styles.pushButton}
            disabled={!canCommit || !!remoteBusy}
            onClick={() => void runner.run(true)}
            title={`${tx(commitAndPushLabel(amend))} (⌥⌘↩)`}
          >
            <span>
              <T>{commitAndPushLabel(amend)}</T>
            </span>
          </Button>
        )}
        <span className={styles.grow} />
        <IconButton
          ref={optionsRef}
          icon="settings"
          title="Commit Options"
          size="small"
          aria-haspopup="dialog"
          aria-expanded={optionsOpen === "options"}
          onClick={() => setOptionsOpen((open) => (open === "options" ? null : "options"))}
        />
        {optionsOpen && (
          <CommitOptionsPopup
            key={optionsOpen}
            anchor={optionsOpen === "author" && author ? authorRef : optionsRef}
            focusAuthor={optionsOpen === "author"}
            onClose={() => setOptionsOpen(null)}
          />
        )}
      </div>
    </div>
  );
}
