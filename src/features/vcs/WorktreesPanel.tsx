import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Worktree } from "@/bindings";
import { choosePath } from "@/platform/choosePath";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { HighlightedText, Icon, IconButton, Menu, Tree, type MenuItem } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { confirmDialog } from "./dialogs";
import { baseName } from "./model";
import { errorMessage } from "./ops";
import { openWorktree } from "./openWorktree";
import { repoName, useVcs } from "./store";
import {
  groupWorktrees,
  isCurrentWorktree,
  worktreeContainsProject,
  worktreeLocation,
  worktreeMoveTarget,
  worktreePathKey,
  type RepoWorktrees,
} from "./worktrees";
import { showNewWorktree } from "./NewWorktreeDialog";
import { OPEN_WORKTREE_REVIEW, useWorktreeReviews } from "./worktreeReviews";
import styles from "./common.module.css";
import layout from "./Worktrees.module.css";

const worktreeKey = (path: string) => `w:${worktreePathKey(path)}`;
const oneSelection = (key?: string | null): ReadonlySet<string> => new Set(key ? [key] : []);

/** A repository section of the Worktrees tree; its children are the repository's worktrees. */
interface WorktreeNode {
  key: string;
  label: string;
  repo: string;
  worktree?: Worktree;
  children?: WorktreeNode[];
}

const folderOf = (node: WorktreeNode) =>
  node.worktree ? baseName(node.worktree.path.replaceAll("\\", "/")) || node.worktree.path : node.label;

export function WorktreesPanel({ className, listClassName }: { className?: string; listClassName?: string }) {
  const rowHeight = useRowHeight(40);
  const projectRoot = useProject((s) => s.project?.root);
  const repo = useVcs((s) => s.repo);
  const repos = useVcs((s) => s.roots);
  const branches = useVcs((s) => s.branches);
  const [groups, setGroups] = useState<RepoWorktrees[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => oneSelection());
  const [mutationError, setMutationError] = useState<{ project: string | undefined; message: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const reviews = useWorktreeReviews(projectRoot, groups, reviewRefresh);
  /** The last reload wins: a scan of the roots may change them while it runs. */
  const run = useRef(0);
  const mutating = useRef(false);
  const reload = useCallback(() => {
    const id = ++run.current;
    return Promise.all(
      useVcs.getState().roots.map((root) =>
        call(commands.vcsWorktrees(root)).then(
          (worktrees): RepoWorktrees => ({ root, worktrees }),
          (e): RepoWorktrees => ({ root, worktrees: [], error: errorMessage(e) }),
        ),
      ),
    ).then((lists) => {
      if (id !== run.current) return;
      setGroups(groupWorktrees(lists));
    });
  }, []);
  useEffect(() => {
    void reload();
  }, [repos, branches, reload]);
  const tree = useMemo(
    () =>
      groups.map((group): WorktreeNode => ({
        // The main worktree names a repository across reloads (its linked roots come and go).
        key: `r:${group.worktrees.find((w) => w.main)?.path ?? group.root}`,
        label: repoName(group.root),
        repo: group.root,
        children: group.worktrees.map((w): WorktreeNode => ({
          key: worktreeKey(w.path),
          label: w.branch ?? (w.head ? w.head.slice(0, 8) : tx("(bare)")),
          repo: group.root,
          worktree: w,
        })),
      })),
    [groups],
  );
  const selectedNodes = tree.flatMap((n) => [n, ...(n.children ?? [])]).filter((n) => selected.has(n.key));
  const selectedRepos = new Set(selectedNodes.map((n) => n.repo));
  const selectedWorktrees = selectedNodes.flatMap((n) => (n.worktree ? [n.worktree] : []));
  const defaultGroup =
    groups.find((g) => g.root === repo || (repo && g.worktrees.some((w) => isCurrentWorktree(w.path, repo)))) ??
    (groups.length === 1 ? groups[0] : undefined);
  const currentGroup =
    selectedRepos.size === 1
      ? groups.find((g) => selectedRepos.has(g.root))
      : selectedRepos.size === 0
        ? defaultGroup
        : undefined;
  const current = selectedNodes.length === 1 ? selectedNodes[0]?.worktree : undefined;
  const containsProject = selectedWorktrees.some((tree) => worktreeContainsProject(tree.path, projectRoot));
  const canModify =
    !!currentGroup &&
    !!selectedWorktrees.length &&
    selectedWorktrees.length === selectedNodes.length &&
    !containsProject &&
    selectedWorktrees.every((tree) => !tree.main && !tree.prunable);
  const canOpen = (w: Worktree | undefined) => !!w && !!w.head && !w.prunable;
  const canLock = canModify && !!current;
  const canRemove = canModify && selectedWorktrees.every((tree) => !tree.locked);
  const canMove = canRemove && !!current;
  const removeLabel = selectedWorktrees.length > 1 ? "Remove Worktrees" : "Remove Worktree";
  const prunable = currentGroup?.worktrees.filter((w) => w.prunable) ?? [];
  const isCurrent = (path: string) => repos.some((root) => isCurrentWorktree(path, root));
  const mutate = async (task: () => Promise<unknown>, selection: ReadonlySet<string>) => {
    if (mutating.current || projectRoot !== useProject.getState().project?.root) return;
    mutating.current = true;
    setBusy(true);
    let failure: string | null = null;
    try {
      await task();
    } catch (e) {
      failure = errorMessage(e);
    }
    if (projectRoot === useProject.getState().project?.root) {
      setMutationError(failure === null ? null : { project: projectRoot, message: failure });
      if (failure === null) setSelected(selection);
      await reload();
    }
    mutating.current = false;
    setBusy(false);
  };

  const remove = async () => {
    if (!canRemove || !currentGroup) return;
    const paths = selectedWorktrees.map((tree) => tree.path).join("\n");
    const ok = await confirmDialog({
      title: removeLabel,
      message: current
        ? tx`Remove the worktree at ${current.path}? Its folder is deleted.`
        : tx`Remove these worktrees and delete their folders?\n${paths}`,
      okLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await mutate(async () => {
      for (const tree of selectedWorktrees) {
        if (projectRoot !== useProject.getState().project?.root) return;
        try {
          await call(commands.vcsRemoveWorktree(currentGroup.root, tree.path, false));
        } catch (e) {
          if (projectRoot !== useProject.getState().project?.root) return;
          const force = await confirmDialog({
            title: "Remove Worktree",
            message: tx`${errorMessage(e)}\n\nRemove it anyway, discarding its changes?`,
            okLabel: "Force Remove",
            danger: true,
          });
          if (!force) throw e;
          if (projectRoot === useProject.getState().project?.root)
            await call(commands.vcsRemoveWorktree(currentGroup.root, tree.path, true));
        }
      }
    }, oneSelection());
  };

  const move = async () => {
    if (!current || !currentGroup || !canMove) return;
    const folder = await choosePath({
      directory: true,
      title: tx("Move Worktree"),
      defaultPath: worktreeLocation(current.path),
    });
    if (!folder) return;
    const to = worktreeMoveTarget(current.path, folder);
    if (isCurrentWorktree(to, current.path)) return;
    const ok = await confirmDialog({
      title: "Move Worktree",
      message: tx`Move the worktree at ${current.path} to ${to}?`,
      okLabel: "Move",
    });
    if (!ok) return;
    await mutate(
      () => call(commands.vcsMoveWorktree(currentGroup.root, current.path, to)),
      oneSelection(worktreeKey(to)),
    );
  };

  const toggleLock = () => {
    if (!current || !currentGroup || !canLock) return;
    void mutate(() => call(commands.vcsSetWorktreeLocked(currentGroup.root, current.path, !current.locked)), selected);
  };

  const prune = async () => {
    if (!currentGroup || !prunable.length) return;
    const paths = prunable.map((w) => w.path).join("\n");
    if (
      !(await confirmDialog({
        title: "Prune Worktrees",
        message: tx`Remove Git records for these missing worktrees?\n${paths}`,
        okLabel: "Prune",
      }))
    )
      return;
    const remaining = new Set([...selected].filter((key) => !prunable.some((tree) => worktreeKey(tree.path) === key)));
    await mutate(() => call(commands.vcsPruneWorktrees(currentGroup.root)), remaining);
  };

  const createWorktree = () =>
    showNewWorktree({
      repo: currentGroup?.root ?? repo ?? repos[0],
      onCreated: (path) => {
        setSelected(oneSelection(worktreeKey(path)));
        void reload();
      },
    });
  const openSelected = (w?: Worktree) => {
    if (w && canOpen(w)) void openWorktree(w.path, true);
  };
  const selectedReview = current?.branch && currentGroup ? reviews?.get(currentGroup.root)?.get(current.branch) : null;
  const lockLabel = current?.locked ? "Unlock Worktree" : "Lock Worktree";
  const menuItems: MenuItem[] = [
    { label: "Open in New Window", icon: "folder", disabled: !canOpen(current), run: () => openSelected(current) },
    ...(selectedReview ? [{ kind: "action" as const, action: OPEN_WORKTREE_REVIEW, arg: selectedReview }] : []),
    { label: "New Worktree…", icon: "plus", disabled: busy, run: createWorktree },
    { kind: "separator" },
    { label: lockLabel, icon: current?.locked ? "unlock" : "lock", disabled: busy || !canLock, run: toggleLock },
    { label: "Move Worktree…", disabled: busy || !canMove, run: () => void move() },
    { label: removeLabel, disabled: busy || !canRemove, danger: true, run: () => void remove() },
    { label: "Prune Worktrees…", disabled: busy || !prunable.length, run: () => void prune() },
  ];

  return (
    <div className={clsx(layout.panel, className)}>
      <div className={layout.body}>
        <div className={layout.toolbar} role="toolbar" aria-label={tx("Worktrees")} aria-orientation="vertical">
          <IconButton
            icon="refresh"
            title="Refresh"
            size="small"
            onClick={() => {
              void reload();
              setReviewRefresh((value) => value + 1);
            }}
          />
          <IconButton
            icon="plus"
            title="New Worktree…"
            size="small"
            disabled={busy || !repos.length}
            onClick={createWorktree}
          />
          <IconButton
            icon="minus"
            title={containsProject ? "Cannot remove a worktree containing the open project." : removeLabel}
            aria-label={removeLabel}
            size="small"
            disabled={busy || !canRemove}
            onClick={() => void remove()}
          />
          <IconButton
            icon="export"
            title={containsProject ? "Cannot move a worktree containing the open project." : "Move Worktree…"}
            aria-label="Move Worktree…"
            size="small"
            disabled={busy || !canMove}
            onClick={() => void move()}
          />
          <IconButton
            icon="folder"
            title="Open in New Window"
            size="small"
            disabled={!canOpen(current)}
            onClick={() => openSelected(current)}
          />
          <IconButton
            icon={current?.locked ? "unlock" : "lock"}
            title={lockLabel}
            size="small"
            disabled={busy || !canLock}
            onClick={toggleLock}
          />
          <IconButton
            icon="trash"
            title="Prune Worktrees…"
            size="small"
            disabled={busy || !prunable.length}
            onClick={() => void prune()}
          />
        </div>
        <Tree<WorktreeNode>
          // A new set of repositories starts with every section expanded.
          key={tree.map((n) => n.key).join("|")}
          roots={tree}
          getKey={(n) => n.key}
          getLabel={(n) => (n.worktree ? `${folderOf(n)} ${n.label}` : n.label)}
          getChildren={(n) => n.children}
          isExpandable={(n) => !!n.children}
          renderNode={(node, { matches }) => {
            const w = node.worktree;
            const folder = folderOf(node);
            const branchStart = folder.length + 1;
            if (!w) {
              return (
                <>
                  <Icon name="folder" size={16} className={layout.icon} />
                  <HighlightedText className={layout.truncated} text={folder} indices={matches} tone="accent" />
                </>
              );
            }
            const current = isCurrent(w.path);
            const review = w.branch ? reviews?.get(node.repo)?.get(w.branch) : undefined;
            return (
              <>
                <Icon
                  name={current ? "check" : "folder"}
                  label={current ? tx("current") : undefined}
                  size={16}
                  className={clsx(layout.icon, layout.leading)}
                />
                <div className={layout.details}>
                  <span className={layout.line}>
                    <HighlightedText
                      className={clsx(layout.truncated, w.main && layout.main)}
                      text={folder}
                      indices={matches?.filter((index) => index < folder.length)}
                      tone="accent"
                    />
                    {w.locked && <Icon name="lock" size={12} label={tx("locked")} />}
                    {w.prunable && <Icon name="warning" size={12} label={tx("prunable")} />}
                    {w.submodule && <span className={layout.kind}>{tx("Submodule")}</span>}
                    {review && (
                      <span className={layout.review} title={review.title}>
                        <Icon name="toolwindow-pull-requests" size={12} />
                        <span className={layout.truncated}>{review.title}</span>
                      </span>
                    )}
                  </span>
                  <span className={layout.secondary}>
                    <Icon name="branch" size={12} />
                    <HighlightedText
                      className={layout.truncated}
                      text={node.label}
                      indices={matches?.filter((index) => index >= branchStart).map((index) => index - branchStart)}
                      tone="accent"
                    />
                    <span className={clsx(layout.path, layout.truncated)} title={w.path}>
                      {w.path}
                    </span>
                  </span>
                </div>
              </>
            );
          }}
          defaultExpanded={tree.map((n) => n.key)}
          selected={selected}
          onSelectionChange={setSelected}
          onActivate={(n) => openSelected(n.worktree)}
          onContextMenu={(n, selection, event) => {
            if (!n) return;
            setSelected(selection);
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          className={clsx(layout.tree, listClassName)}
          rowHeight={rowHeight}
          aria-label="Worktrees"
        />
      </div>
      {menu && <Menu open anchor={menu} items={menuItems} onClose={() => setMenu(null)} />}
      {groups.map(
        (group) =>
          group.error && (
            <div key={group.root} className={styles.error}>
              {group.error}
            </div>
          ),
      )}
      {mutationError && mutationError.project === projectRoot && (
        <div className={styles.error} role="alert">
          {mutationError.message}
        </div>
      )}
    </div>
  );
}
