/**
 * The changes tree (`CodeReviewChangeListComponentFactory` with
 * `CodeReviewProgressRenderer`): file names in their VCS status colour, grouped by
 * directory or flat, and on the right of files and collapsed folders the unresolved
 * thread counter (unread icon while the file is not viewed), the unread dot of files not
 * viewed, and — for the "All commits" list — a viewed checkbox shown on hover and kept
 * checked once viewed. Double-click / Enter opens the diff; the context menu is
 * `Github.PullRequest.Changes.Popup`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { dirKeys, type FileTreeNode } from "@/features/vcs/fileTree";
import { baseName, dirName, fileCount, KIND_COLOR } from "@/features/vcs/model";
import { currentRepoRoot } from "@/features/vcs/store";
import { useTx } from "@/platform/i18n";
import { Icon, Tree, fileIconName, showContextMenu, T, type MenuItem, type TreeHandle } from "@/ui";
import { editorService } from "@/workbench/contributions";
import type { GHCommitFile, GHPullRequestFileViewedState, GHPullRequestReviewThread } from "../api/types";
import { openPullRequestFileDiff } from "../data/local";
import { setViewed } from "../data/operations";
import { provideGithubHandler } from "../toolwindow/handlers";
import { openCommitFileDiff } from "./flow";
import {
  changeKind,
  changesTree,
  isViewed,
  progressOf,
  selectedFiles,
  unresolvedThreadsByPath,
  viewedToggleText,
  type ProgressState,
} from "./model";
import { setGroupByDirectory, useChangesGrouping } from "./state";
import styles from "./Details.module.css";

type Node = FileTreeNode<GHCommitFile>;

const NONE: ReadonlySet<string> = new Set();

export interface ChangesTreeProps {
  number: number;
  files: readonly GHCommitFile[];
  /** The commit whose changes these are; null for all commits (the cumulative list, with viewed state). */
  commitSha: string | null;
  viewedState: Record<string, GHPullRequestFileViewedState> | undefined;
  threads: readonly GHPullRequestReviewThread[] | undefined;
  /** The head branch is checked out (its files can be edited). */
  checkedOut: boolean;
}

export function ChangesTree({ number, files, commitSha, viewedState, threads, checkedOut }: ChangesTreeProps) {
  const tx = useTx();
  const grouped = useChangesGrouping((s) => s.byDirectory);
  const hasViewedState = commitSha === null;
  const tree = useRef<TreeHandle>(null);
  const roots = useMemo(() => changesTree(files, grouped), [files, grouped]);
  const allDirs = useMemo(() => dirKeys(roots), [roots]);
  // Everything starts expanded; collapsing is remembered while the list stays the same.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NONE);
  const expanded = useMemo(() => new Set(allDirs.filter((k) => !collapsed.has(k))), [allDirs, collapsed]);
  const setExpanded = (next: ReadonlySet<string>) => setCollapsed(new Set(allDirs.filter((k) => !next.has(k))));
  const [selection, setSelection] = useState<ReadonlySet<string>>(NONE);

  const discussions = useMemo(() => unresolvedThreadsByPath(threads ?? []), [threads]);
  const leaf = useMemo(
    () =>
      (f: GHCommitFile): ProgressState => ({
        isRead: hasViewedState ? isViewed(viewedState?.[f.filename]) : true,
        discussions: discussions.get(f.filename) ?? 0,
      }),
    [hasViewedState, viewedState, discussions],
  );
  // Until the threads and the viewed state load, no state is shown (`isLoading`).
  const loading = threads === undefined || (hasViewedState && viewedState === undefined);

  const openDiff = (f: GHCommitFile) =>
    void (commitSha ? openCommitFileDiff(number, commitSha, f) : openPullRequestFileDiff(number, f.filename));
  const jumpToSource = (f: GHCommitFile) => {
    const root = currentRepoRoot();
    if (root) void editorService().openFile(`${root.replace(/[\\/]+$/, "")}/${f.filename}`, { focus: true });
  };
  const canEdit = (f: GHCommitFile) =>
    f.status !== "removed" && (checkedOut || (f.status !== "added" && f.status !== "copied"));

  const toggle = (chosen: readonly GHCommitFile[]) => {
    if (!hasViewedState || !chosen.length) return;
    const allViewed = chosen.every((f) => leaf(f).isRead);
    void setViewed(
      number,
      chosen.map((f) => f.filename),
      !allViewed,
    ).catch(() => undefined);
  };

  // `Github.PullRequest.Changed.MarkViewed.Toggle` on the selection (⇧⌘S, the context menu).
  const toggleRef = useRef(() => {});
  useLayoutEffect(() => {
    toggleRef.current = () => toggle(selectedFiles(roots, selection));
  });
  useEffect(() => provideGithubHandler("toggleViewed", () => toggleRef.current()), []);

  const onContextMenu = (_node: Node | null, keys: Set<string>, e: MouseEvent) => {
    setSelection(keys);
    const chosen = selectedFiles(roots, keys);
    const first = chosen[0];
    const allViewed = chosen.every((f) => leaf(f).isRead);
    const items: MenuItem[] = [
      { label: "Show Diff", icon: "diff", disabled: !first, run: () => first && openDiff(first) },
      { label: "Show Diff in a New Tab or Window", disabled: !first, run: () => first && openDiff(first) },
      {
        label: "Jump to Source",
        icon: "edit-source",
        disabled: !first || !canEdit(first),
        run: () => first && jumpToSource(first),
      },
      ...(hasViewedState && chosen.length
        ? [
            {
              kind: "action" as const,
              action: "github.pullRequest.toggleViewed",
              label: viewedToggleText(chosen.length, allViewed),
            },
          ]
        : []),
      { kind: "separator" },
      {
        label: "View Options",
        icon: "eye",
        submenu: [
          { kind: "header", label: "Group By" },
          { label: "Directory", checked: grouped, run: () => setGroupByDirectory(!grouped) },
        ],
      },
      { label: "Expand All", icon: "expand-all", run: () => setExpanded(new Set(allDirs)) },
      { label: "Collapse All", icon: "collapse-all", run: () => setExpanded(new Set()) },
      { kind: "separator" },
      { kind: "action", action: "github.pullRequest.refresh", arg: number },
      { kind: "action", action: "github.pullRequest.openInBrowser", arg: number },
      { kind: "action", action: "github.pullRequest.copyUrl", arg: number },
    ];
    e.stopPropagation();
    showContextMenu(e, items);
  };

  if (!files.length)
    return (
      <div className={styles.treeEmpty}>
        <T>Pull request does not contain any changes</T>
      </div>
    );

  return (
    <Tree<Node>
      handleRef={tree}
      roots={roots}
      getKey={(n) => n.key}
      getLabel={(n) => n.name}
      getChildren={(n) => (n.file ? undefined : n.children)}
      isExpandable={(n) => !n.file}
      expanded={expanded}
      onExpandedChange={setExpanded}
      selected={selection}
      onSelectionChange={(s) => setSelection(s)}
      rowClassName={() => styles.changeRow}
      renderNode={(n, state) => (
        <ChangeRow
          node={n}
          flat={!grouped}
          progress={loading || (!n.file && state.expanded) ? null : progressOf(n, leaf)}
          hasViewedState={hasViewedState}
          canEdit={!!n.file && canEdit(n.file)}
          onToggleViewed={() => n.file && toggle([n.file])}
          onEdit={() => n.file && jumpToSource(n.file)}
        />
      )}
      onActivate={(n) => n.file && openDiff(n.file)}
      onContextMenu={onContextMenu}
      speedSearch
      aria-label={tx("Changes")}
      className={styles.tree}
    />
  );
}

function ChangeRow(props: {
  node: Node;
  flat: boolean;
  /** Shown for files and collapsed folders once loaded. */
  progress: ProgressState | null;
  hasViewedState: boolean;
  canEdit: boolean;
  onToggleViewed: () => void;
  onEdit: () => void;
}) {
  const { node, flat, progress } = props;
  const tx = useTx();
  const f = node.file;
  const name = f ? (
    <>
      <Icon name={fileIconName(node.name)} size={16} className={styles.fileIcon} />
      <span className={styles.fileName} style={{ color: KIND_COLOR[changeKind(f)] }}>
        {node.name}
      </span>
      {flat && dirName(f.filename) && <span className={styles.fileDir}>{dirName(f.filename)}</span>}
      {f.previousFilename && <span className={styles.fileDir}>{tx`renamed from ${baseName(f.previousFilename)}`}</span>}
    </>
  ) : (
    <>
      <Icon name="folder" size={16} className={styles.fileIcon} />
      <span className={styles.fileName}>{node.name}</span>
      <span className={styles.fileDir}>{fileCount(node.count)}</span>
    </>
  );
  const counter = progress && progress.discussions > 0 && (
    <span className={styles.counter}>
      <Icon name={progress.isRead ? "review-comment" : "review-comment-unread"} size={16} />
      {progress.discussions}
    </span>
  );
  // The checkbox / dot slot: files of the cumulative list get the checkbox (on hover, or
  // kept once viewed); anything unread shows the dot otherwise.
  const toggleable = !!f && props.hasViewedState;
  const checkbox = toggleable && progress && (
    <span
      role="checkbox"
      aria-checked={progress.isRead}
      aria-label={tx(progress.isRead ? "Mark as Not Viewed" : "Mark as Viewed")}
      className={clsx(styles.viewedBox, progress.isRead && styles.viewedChecked)}
      onClick={(e) => {
        e.stopPropagation();
        props.onToggleViewed();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {progress.isRead && <Icon name="check" size={12} />}
    </span>
  );
  const dot = progress && !progress.isRead && <Icon name="review-file-unread" size={16} />;
  return (
    <span
      className={styles.fileRow}
      title={f ? (f.previousFilename ? `${f.previousFilename} → ${f.filename}` : f.filename) : undefined}
    >
      {name}
      {progress && (
        <span className={styles.progress}>
          {props.canEdit ? (
            <>
              <span className={styles.noHover}>{counter}</span>
              <span
                className={clsx(styles.onHover, styles.editSource)}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onEdit();
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Icon name="edit-source" size={16} />
              </span>
            </>
          ) : (
            counter
          )}
          {(counter || checkbox || dot) && (
            <span className={styles.readSlot}>
              {toggleable && progress.isRead ? (
                checkbox
              ) : (
                <>
                  {dot && <span className={toggleable ? styles.noHover : undefined}>{dot}</span>}
                  {toggleable && <span className={styles.onHover}>{checkbox}</span>}
                </>
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
