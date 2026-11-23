import type { Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { MenuItem } from "@/ui";
import { branchMenu, inRepo } from "../branchMenu";
import { commitKey, commitRepo, type RepoCommit } from "../multiRoot";
import { undoCommitProblem } from "../rebasePlan";
import { browseRepositoryAt } from "../RevisionBrowser";
import { currentRepoRoot, useVcs } from "../store";
import type { FileHistoryCommitArg, FileHistoryCommitsArg } from "../historyActions";

/**
 * The commit context menu in Git Log and File History, in the order of the IDE's Git Log menu.
 * The selection is ordered newest first. For several commits, actions that edit one commit are hidden
 * and the other single-commit actions are disabled.
 */
export function commitMenu(c: Commit, selection: Commit[] = [c], fileHistoryTarget?: string | null): MenuItem[] {
  const actionCommit: Commit | FileHistoryCommitArg = fileHistoryTarget
    ? { kind: "file-history-commit", commit: c, target: fileHistoryTarget }
    : c;
  if ((c as RepoCommit).readOnly)
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: c },
      { kind: "separator" },
      { label: "Show Repository at Revision", run: () => browseRepositoryAt(c) },
      ...(fileHistoryTarget
        ? [{ kind: "action" as const, action: "vcs.log.showFileAtRevision", arg: actionCommit }]
        : []),
      { kind: "separator" },
      { kind: "action", action: "vcs.log.goToChild", arg: c, icon: null },
      { kind: "action", action: "vcs.log.goToParent", arg: c, icon: null },
    ];
  const many = selection.length > 1 && selection.some((x) => commitKey(x) === commitKey(c));
  const commits = many ? selection : [c];
  const repo = commitRepo(c);
  const vcs = useVcs.getState();
  const branchInfo = repo ? vcs.heads[repo] : vcs.branch;
  const head = branchInfo?.head ?? null;
  const operation = repo ? vcs.operations[repo] : vcs.branch?.operation;
  const cannotApply = commits.some((commit) => commit.parents.length > 1 || (commit as RepoCommit).readOnly);
  const compareArg: Commit[] | FileHistoryCommitsArg = fileHistoryTarget
    ? { kind: "file-history-commits", commits: selection, target: fileHistoryTarget }
    : selection;
  const single = (action: string, extra: Partial<Extract<MenuItem, { kind: "action" }>> = {}): MenuItem => ({
    kind: "action",
    action,
    arg: c,
    icon: null,
    ...extra,
    disabled: many || !!extra.disabled,
  });

  const branches = ((c as RepoCommit).refBranches ?? []).filter(
    (branch) => !branch.current && (branch.remote || branch.name !== head),
  );
  const local = branches.filter((branch) => !branch.remote).sort((a, b) => a.name.localeCompare(b.name));
  const revision = c.shortId;
  const checkoutRepo = repo ?? currentRepoRoot();
  const checkout: MenuItem[] = many
    ? []
    : local.length
      ? [
          {
            label: "Checkout",
            submenu: [
              ...local.map((branch): MenuItem => ({
                label: branch.name,
                verbatim: true,
                run: () => void executeAction("vcs.log.checkoutBranch", { branch, repo: checkoutRepo }),
              })),
              { kind: "action", action: "vcs.log.checkoutRevision", label: tx`Revision '${revision}'`, arg: c },
            ],
          },
        ]
      : [{ kind: "action", action: "vcs.log.checkoutRevision", label: tx`Checkout Revision '${revision}'`, arg: c }];
  const branchActions: MenuItem[] = many
    ? []
    : branches.map((branch) => {
        const menu = branchMenu(branch, head, undefined, { headCommit: branchInfo?.headCommit ?? null });
        return {
          label: tx`Branch '${branch.name}'`,
          submenu: repo ? inRepo(repo, menu) : menu,
        };
      });
  if (!many && !branchActions.length)
    branchActions.push({
      kind: "action",
      action: "vcs.log.rebaseOntoCommit",
      arg: c,
      label: tx`Rebase '${head ?? "HEAD"}' onto Selected Commit`,
      disabled: !head,
    });

  return [
    { kind: "action", action: "vcs.log.copyRevision", arg: many ? selection : c },
    { kind: "action", action: "vcs.log.createPatch", arg: many ? selection : c, icon: "patch" },
    {
      kind: "action",
      action: "vcs.log.cherryPick",
      arg: many ? selection : c,
      icon: "cherry-pick",
      disabled: cannotApply,
    },
    { kind: "separator" },
    ...checkout,
    { label: "Show Repository at Revision", disabled: many, run: () => browseRepositoryAt(c) },
    ...(fileHistoryTarget ? [single("vcs.log.showFileAtRevision", { arg: actionCommit })] : []),
    ...(selection.length === 2 && many
      ? [{ kind: "action" as const, action: "vcs.log.compareVersions", arg: compareArg, icon: null }]
      : []),
    single("vcs.log.compareWithLocal", { arg: actionCommit }),
    { kind: "separator" },
    single("vcs.log.resetToHere", { icon: "revert" }),
    { kind: "action", action: "vcs.log.revert", arg: many ? selection : c, icon: null, disabled: cannotApply },
    // Editing one commit is hidden, not disabled, for a multiple selection.
    ...(many
      ? []
      : [
          single("vcs.log.undoCommit", {
            disabled: !!branchInfo && !!undoCommitProblem(c, { ...branchInfo, operation }),
          }),
        ]),
    { kind: "separator" },
    ...(many ? [] : [single("vcs.log.editMessage"), single("vcs.log.fixup"), single("vcs.log.squashInto")]),
    { kind: "action", action: "vcs.log.dropCommit", arg: many ? selection : c, label: "Drop Commits" },
    ...(many ? [{ kind: "action" as const, action: "vcs.log.squashCommits", arg: selection }] : []),
    ...(many ? [] : [single("vcs.log.interactiveRebase")]),
    single("vcs.log.pushUpToHere"),
    { kind: "separator" },
    ...(branchActions.length > 2 ? [{ label: "Branches", submenu: branchActions }] : branchActions),
    single("vcs.log.newBranch"),
    single("vcs.log.newTag"),
    { kind: "separator" },
    single("vcs.log.goToChild"),
    single("vcs.log.goToParent", { disabled: !c.parents.length }),
    { kind: "separator" },
    { kind: "action", action: "vcs.log.openInBrowser", arg: c, disabled: many },
  ];
}
