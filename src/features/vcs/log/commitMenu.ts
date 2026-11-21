import type { Commit } from "@/bindings";
import { useBookmarkPopups } from "@/features/search/bookmarks/store";
import { tx } from "@/platform/i18n";
import { copyText, type MenuItem } from "@/ui";
import { branchMenu, inRepo } from "../branchMenu";
import { commitBookmarkPath } from "../logBookmarks";
import { loadLogDetails } from "../logDetails";
import { toggleCommitBookmark, useGitLog } from "../logStore";
import { commitKey, commitRepo, type RepoCommit } from "../multiRoot";
import { browseRepositoryAt } from "../RevisionBrowser";
import { useVcs } from "../store";
import type { FileHistoryCommitArg, FileHistoryCommitsArg } from "../historyActions";

/** The commit context menu in Git Log and File History. The selection is ordered newest first. */
export function commitMenu(c: Commit, selection: Commit[] = [c], fileHistoryTarget?: string | null): MenuItem[] {
  const actionCommit: Commit | FileHistoryCommitArg = fileHistoryTarget
    ? { kind: "file-history-commit", commit: c, target: fileHistoryTarget }
    : c;
  if ((c as RepoCommit).readOnly)
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: c },
      { label: "Copy Commit Message", run: () => copyCommitMessage(c) },
      { kind: "separator" },
      { label: "Browse Repository at Revision", run: () => browseRepositoryAt(c) },
      ...(fileHistoryTarget
        ? [{ kind: "action" as const, action: "vcs.log.showFileAtRevision", arg: actionCommit }]
        : []),
      { kind: "separator" },
      { kind: "action", action: "vcs.log.goToChild", arg: c },
      { kind: "action", action: "vcs.log.goToParent", arg: c },
      { kind: "separator" },
      ...bookmarkItems(c),
    ];
  const many = selection.length > 1 && selection.some((x) => commitKey(x) === commitKey(c));
  const repo = commitRepo(c);
  const vcs = useVcs.getState();
  const head = (repo ? vcs.heads[repo]?.head : vcs.branch?.head) ?? null;
  const { outgoing } = useGitLog.getState();
  if (many) {
    const compareArg: Commit[] | FileHistoryCommitsArg = fileHistoryTarget
      ? { kind: "file-history-commits", commits: selection, target: fileHistoryTarget }
      : selection;
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: selection, label: "Copy Revision Numbers" },
      { kind: "action", action: "vcs.log.createPatch", arg: selection },
      { kind: "separator" },
      ...(selection.length === 2
        ? ([
            { kind: "action", action: "vcs.log.compareVersions", arg: compareArg },
            { kind: "separator" },
          ] satisfies MenuItem[])
        : []),
      { kind: "action", action: "vcs.log.cherryPick", arg: selection },
      { kind: "action", action: "vcs.log.revert", arg: selection, label: "Revert Commits" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.squashCommits", arg: selection },
      { kind: "action", action: "vcs.log.dropCommit", arg: selection, label: "Drop Commits" },
    ];
  }
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere =
    !!head &&
    ((commitRepo(c) === undefined ? !!outgoing : useGitLog.getState().tracked.has(commitRepo(c) ?? ""))
      ? !!outgoing?.has(commitKey(c))
      : true);
  const branches = ((c as RepoCommit).refBranches ?? []).filter((branch) => !branch.current);
  const branchActions: MenuItem[] = branches.map((branch) => {
    const menu = branchMenu(branch, head);
    return {
      label: tx`Branch '${branch.name}'`,
      submenu: repo ? inRepo(repo, menu) : menu,
    };
  });
  if (!branchActions.length)
    branchActions.push({
      kind: "action",
      action: "vcs.log.rebaseOntoCommit",
      arg: c,
      label: tx`Rebase '${head ?? "HEAD"}' onto Selected Commit`,
      disabled: !head,
    });
  return [
    { kind: "action", action: "vcs.log.copyRevision", arg: c },
    { label: "Copy Commit Message", run: () => copyCommitMessage(c) },
    { kind: "action", action: "vcs.log.createPatch", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.checkoutRevision", arg: c },
    { label: "Browse Repository at Revision", run: () => browseRepositoryAt(c) },
    ...(fileHistoryTarget
      ? [{ kind: "action" as const, action: "vcs.log.showFileAtRevision", arg: actionCommit }]
      : []),
    { kind: "action", action: "vcs.log.compareWithLocal", arg: actionCommit },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.cherryPick", arg: c },
    { kind: "action", action: "vcs.log.resetToHere", arg: c },
    { kind: "action", action: "vcs.log.revert", arg: c },
    { kind: "action", action: "vcs.log.undoCommit", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.editMessage", arg: c },
    { kind: "action", action: "vcs.log.fixup", arg: c },
    { kind: "action", action: "vcs.log.squashInto", arg: c },
    { kind: "action", action: "vcs.log.dropCommit", arg: c },
    { kind: "action", action: "vcs.log.interactiveRebase", arg: c },
    { kind: "action", action: "vcs.log.pushUpToHere", arg: c, disabled: !canPushHere },
    { kind: "separator" },
    ...(branchActions.length > 2 ? [{ label: "Branches", submenu: branchActions }] : branchActions),
    { kind: "action", action: "vcs.log.newBranch", arg: c },
    { kind: "action", action: "vcs.log.newTag", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.goToChild", arg: c },
    { kind: "action", action: "vcs.log.goToParent", arg: c, disabled: !c.parents.length },
    { kind: "separator" },
    ...bookmarkItems(c),
    { kind: "separator" },
    { kind: "action", action: "vcs.log.openInBrowser", arg: c },
  ];
}

function bookmarkItems(commit: Commit): MenuItem[] {
  return [
    {
      label: useGitLog.getState().bookmarks[commitKey(commit)] ? "Remove Commit Bookmark" : "Bookmark Commit",
      run: () => toggleCommitBookmark(commit),
    },
    {
      label: "Assign Mnemonic",
      run: () =>
        useBookmarkPopups.setState({ chooser: { path: commitBookmarkPath(commit), line: 0, text: commit.summary } }),
    },
  ];
}

async function copyCommitMessage(c: Commit) {
  const message = c.messageTruncated ? (await loadLogDetails(c)).message : c.message;
  await copyText(message);
}
