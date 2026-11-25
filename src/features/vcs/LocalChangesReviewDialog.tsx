import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckoutOptions, FileStatus } from "@/bindings";
import { bindingsFor, normalizeBinding, registerKeyClaim, shortcutLabel } from "@/platform/keymap";
import { Button, Dialog, Icon, IconButton, T, Tree, fileIconName, showContextMenu, type DialogButton } from "@/ui";
import { showRollbackDialog } from "./changeOps";
import { isNestedRepoEntry } from "./submoduleRollback";
import { groupOf, isPartiallyStaged } from "./changes";
import { workingDiffData, withChain } from "./diffInput";
import { openDialog } from "./dialogs";
import { dirKeys, type FileTreeNode } from "./fileTree";
import { filesUnder } from "./logChanges";
import { baseName, dirName, effectiveKind, KIND_COLOR, rootOf } from "./model";
import { repositoryPath } from "./repositoryPaths";
import { refreshNow, repoName, useVcs } from "./store";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import styles from "./LocalChangesReviewDialog.module.css";

export type AffectedFiles = readonly [repo: string | null, files: readonly string[]];
type ReviewMode = "checkout" | "merge" | "blockedMerge";
type ReviewDecision = { mode: CheckoutOptions["mode"]; files: AffectedFiles[] };

const operationText = {
  checkout: {
    title: "Git Checkout Problem",
    wouldOverwrite: "Checkout would overwrite the local changes in these files.",
    cleared: "The listed local changes are gone. You can retry checkout.",
    regular: "Checkout",
    smart: "Smart Checkout",
    cancel: "Don't Checkout",
    shelve: "Smart Checkout shelves your changes and restores them after checkout.",
    stash: "Smart Checkout stashes your changes and restores them after checkout.",
  },
  merge: {
    title: "Git Merge Problem",
    wouldOverwrite: "Merge would overwrite the local changes in these files.",
    cleared: "The listed local changes are gone. You can retry merge.",
    regular: "Merge",
    smart: "Smart Merge",
    cancel: "Don't Merge",
    shelve: "Smart Merge shelves your changes and restores them after merging.",
    stash: "Smart Merge stashes your changes and restores them after merging.",
  },
};

interface ReviewFile {
  key: string;
  status: FileStatus | undefined;
}

function changesByPath(status: readonly FileStatus[], roots: readonly string[]) {
  const changes = new Map<string, FileStatus>();
  const renamed = new Map<string, FileStatus>();
  for (const file of status) {
    if (groupOf(file) !== "changes" || isNestedRepoEntry(file.path, roots)) continue;
    const root = rootOf(file.path, roots);
    changes.set(repositoryPath(root, file.relPath), file);
    if (file.renamedFrom) renamed.set(repositoryPath(root, file.renamedFrom), file);
  }
  return new Map([...renamed, ...changes]);
}

export async function reviewLocalChanges(
  operation: ReviewMode,
  affected: readonly AffectedFiles[],
  showRepositories: boolean,
): Promise<ReviewDecision | null> {
  await refreshNow();
  return new Promise((resolve) => {
    openDialog((close) => (
      <LocalChangesReviewDialog
        operation={operation}
        affected={affected}
        showRepositories={showRepositories}
        onDone={(decision) => {
          close();
          resolve(decision);
        }}
      />
    ));
  });
}

function LocalChangesReviewDialog({
  operation,
  affected,
  showRepositories,
  onDone,
}: {
  operation: ReviewMode;
  affected: readonly AffectedFiles[];
  showRepositories: boolean;
  onDone: (decision: ReviewDecision | null) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const status = useVcs((s) => s.status);
  const roots = useVcs((s) => s.roots);
  const policy = useWorkflowSettings((s) => s.vcs.git.saveChangesPolicy);
  const changes = useMemo(() => changesByPath(status, roots), [status, roots]);
  const [known] = useState(() => new Set(changes.keys()));
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const nodes: FileTreeNode<ReviewFile>[] = [];
  const visible: AffectedFiles[] = [];
  for (const [repo, paths] of affected) {
    const children: FileTreeNode<ReviewFile>[] = [];
    for (const relative of paths) {
      const path = repositoryPath(repo, relative);
      const file = changes.get(path);
      if (!file && known.has(path)) continue;
      const key = `file:${path}`;
      children.push({ key, name: relative, file: { key, status: file }, children: [], count: 1 });
    }
    if (!children.length) continue;
    visible.push([repo, children.map((child) => child.name)]);
    if (showRepositories && repo) {
      nodes.push({ key: `repo:${repo}`, name: repoName(repo), file: null, children, count: children.length });
    } else nodes.push(...children);
  }
  const files = filesUnder(nodes);
  const picked = filesUnder(nodes, keys);
  const selected = picked.length || !files[0] ? keys : new Set([files[0].key]);
  const uniqueChanges = (rows: readonly ReviewFile[]) =>
    Array.from(new Map(rows.flatMap(({ status }) => (status ? [[status.path, status] as const] : []))).values());
  const chosen = uniqueChanges(picked.length ? picked : files.slice(0, 1));

  const showDiff = (selection: readonly FileStatus[]) => {
    if (!selection.length) return;
    const chain = selection.length > 1 ? selection : uniqueChanges(files);
    const items = chain.flatMap((file) => {
      const worktree = workingDiffData(file.path);
      if (!isPartiallyStaged(file)) return [worktree];
      const staged = workingDiffData(file.path, undefined, "staged");
      return [{ ...staged, left: worktree.left }, workingDiffData(file.path, undefined, "unstaged")];
    });
    const index = items.findIndex((item) => item.path === selection[0]?.path);
    if (index < 0) return;
    void import("./diffDialog").then(({ openDiffDialog }) => {
      if (content.current?.isConnected) openDiffDialog(withChain(items, index));
    });
  };

  const rollback = async (selection = chosen) => {
    if (!selection.length || rollingBack) return;
    setRollingBack(true);
    try {
      await new Promise<void>((done) => showRollbackDialog(selection, done));
    } finally {
      setRollingBack(false);
    }
  };
  useEffect(() =>
    registerKeyClaim((event, stroke) => {
      if (rollingBack || !(event.target instanceof Node) || !content.current?.contains(event.target)) return false;
      for (const [action, run] of [
        ["vcs.showDiff", () => showDiff(chosen)],
        ["vcs.rollback", () => void rollback()],
      ] as const) {
        if (!bindingsFor(action).some((binding) => normalizeBinding(binding) === stroke)) continue;
        event.preventDefault();
        event.stopPropagation();
        run();
        return true;
      }
      return false;
    }),
  );

  const blocked = files.length > 0;
  const text = operationText[operation === "checkout" ? "checkout" : "merge"];
  const reviewOnly = operation === "blockedMerge";
  const buttons: DialogButton[] = reviewOnly
    ? [{ label: "Close", role: "cancel", disabled: rollingBack }]
    : [
        {
          label: blocked ? text.smart : text.regular,
          role: "default",
          disabled: rollingBack,
          onClick: () => onDone({ mode: blocked ? "smart" : "normal", files: visible }),
        },
        { label: text.cancel, role: "cancel", disabled: rollingBack },
      ];
  return (
    <Dialog
      open
      title={reviewOnly ? "Local Changes Prevent Merge" : text.title}
      blockWorkbenchShortcuts
      onClose={() => !rollingBack && onDone(null)}
      className={styles.dialog}
      width={600}
      minWidth={400}
      minHeight={300}
      resizable="both"
      buttons={buttons}
      footerStart={
        operation === "checkout" && (
          <Button
            title="Discard local changes in affected repositories"
            disabled={!blocked || rollingBack}
            onClick={() => onDone({ mode: "force", files: visible })}
          >
            Force Checkout
          </Button>
        )
      }
    >
      <div ref={content} className={styles.content}>
        <div className={styles.intro}>
          <p>
            <T>{blocked ? text.wouldOverwrite : text.cleared}</T>
          </p>
          {blocked && !reviewOnly && (
            <p className={styles.hint}>
              <T>{text[policy]}</T>
            </p>
          )}
        </div>
        <div className={styles.review}>
          <div className={styles.toolbar}>
            <IconButton
              icon="diff"
              action="vcs.showDiff"
              title="Show Diff"
              size="small"
              disabled={!chosen.length || rollingBack}
              onClick={(event) => {
                event.preventDefault();
                showDiff(chosen);
              }}
            />
            <IconButton
              icon="undo"
              action="vcs.rollback"
              title="Rollback…"
              size="small"
              disabled={!chosen.length || rollingBack}
              onClick={(event) => {
                event.preventDefault();
                void rollback();
              }}
            />
          </div>
          <Tree
            roots={nodes}
            getKey={(node) => node.key}
            getLabel={(node) => node.name}
            getChildren={(node) => node.children}
            isExpandable={(node) => !node.file}
            expanded={expanded ?? new Set(dirKeys(nodes))}
            onExpandedChange={setExpanded}
            selected={selected}
            onSelectionChange={setKeys}
            onActivate={(node) => {
              if (node.file?.status && !rollingBack) showDiff([node.file.status]);
            }}
            onContextMenu={(node, selection, event) => {
              if (!node || rollingBack) return;
              setKeys(selection);
              const changes = uniqueChanges(filesUnder(nodes, selection));
              showContextMenu(event, [
                {
                  label: "Show Diff",
                  icon: "diff",
                  shortcut: shortcutLabel("vcs.showDiff"),
                  disabled: !changes.length,
                  run: () => showDiff(changes),
                },
                {
                  label: "Rollback…",
                  icon: "undo",
                  shortcut: shortcutLabel("vcs.rollback"),
                  disabled: !changes.length,
                  run: () => void rollback(changes),
                },
              ]);
            }}
            aria-label="Changed files"
            className={styles.tree}
            renderNode={(node) => {
              const file = node.file;
              const name = file ? baseName(node.name) : node.name;
              const directory = file ? dirName(node.name) : "";
              const kind = file?.status && effectiveKind(file.status);
              return (
                <>
                  <Icon className={styles.nodeIcon} name={file ? fileIconName(name) : "folder"} size={16} />
                  <span className={styles.fileLabel} title={node.name}>
                    <span className={styles.fileName} style={{ color: kind ? KIND_COLOR[kind] : undefined }}>
                      {name}
                    </span>
                    {directory && <span className={styles.directory}>{directory}</span>}
                  </span>
                </>
              );
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
