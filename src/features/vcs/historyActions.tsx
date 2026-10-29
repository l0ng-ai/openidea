import { commitKey, commitRepo } from "./multiRoot";
/**
 * Actions for operations in progress, Git Log commits, change lists, the shelf
 * and patches (ids are bound in keymaps/intellij-macos.ts where IDEA binds them).
 */
import type { Commit } from "@/bindings";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { checkoutDetached, newBranch, rebaseOnto } from "./branchOps";
import { openUrl } from "./issueLinks";
import { commitWebUrl } from "./model";
import {
  commitChangelist,
  deleteChangelist,
  editChangelist,
  newChangelist,
  setActiveChangelist,
  showMoveToChangelist,
} from "./changelistsUi";
import { useChangelists } from "./changelists";
import { commitWindowFocused } from "./actions";
import { useCommit } from "./commitStore";
import { openCommit } from "./commitUi";
import { goToChild, goToParent, goToRef, selectedCommits, useGitLog } from "./logStore";
import { chooseRevision } from "./RevisionChooser";
import {
  cherryPick,
  controlOperation,
  inProgress,
  newTagOn,
  revertCommits,
  showCompareVersions,
  showCompareWithLocal,
  showResetDialog,
  showTagDialog,
} from "./operations";
import {
  dropCommits,
  editCommitMessage,
  interactivelyRebaseFrom,
  prepareFixup,
  squashCommits,
  undoCommit,
} from "./rebase";
import { showApplyPatch, showCreatePatchForChanges, showCreatePatchForCommits } from "./patches";
import { deleteShelf, renameShelf, shelveChanges, showShelf, unshelve, useShelf } from "./shelf";
import { currentRepo, focusRepo, useVcs } from "./store";

const VCS = "vcsAvailable";
const IN_GIT_LOG = "vcsAvailable && activeToolWindow == git";
const IN_COMMIT = "vcsAvailable && activeToolWindow == commit";

/** The commit an action refers to: its argument (commit or id), else the Git Log selection. */
export function commitArg(arg: unknown): Commit | null {
  const { commits, selected } = useGitLog.getState();
  if (arg && typeof arg === "object" && "id" in arg && "summary" in arg) return arg as Commit;
  const id = typeof arg === "string" ? arg : selected;
  if (!id) return null;
  return commits.find((c) => commitKey(c) === id) ?? null;
}

/** Commits an action refers to: its argument (commit list or commit), else the Git Log selection. */
export function commitsArg(arg: unknown): Commit[] {
  if (Array.isArray(arg)) return arg.filter((x): x is Commit => !!x && typeof x === "object" && "id" in x);
  if (arg) {
    const c = commitArg(arg);
    return c ? [c] : [];
  }
  const selection = selectedCommits();
  return selection.length ? selection : [commitArg(undefined)].filter((c): c is Commit => !!c);
}

function withCommits(fn: (cs: Commit[]) => unknown) {
  return async ({ arg }: { arg?: unknown }) => {
    const cs = commitsArg(arg);
    if (!cs.length) {
      notifications().notify({ group: "vcs", level: "info", title: "Select a commit in the Git log" });
      return;
    }
    if (new Set(cs.map(commitRepo)).size > 1) return;
    const repo = commitRepo(cs[0]!);
    if (repo) await focusRepo(repo);
    void fn(cs);
  };
}

/** View in Browser: the commit page on the web UI of the current branch's remote (or `origin`). */
async function openCommitInBrowser(c: Commit) {
  const upstream = useVcs.getState().branch?.upstream;
  const remote = upstream ? upstream.slice(0, upstream.indexOf("/")) : "origin";
  const url = await call(commands.vcsConfigGet(currentRepo(), `remote.${remote}.url`)).catch(() => null);
  const page = url ? commitWebUrl(url, c.id) : null;
  if (page) await openUrl(page);
  else notifications().notify({ group: "vcs", level: "warning", title: `No web URL for remote '${remote}'` });
}

function withCommit(fn: (c: Commit) => unknown) {
  return async ({ arg }: { arg?: unknown }) => {
    const c = commitArg(arg);
    if (!c) {
      notifications().notify({ group: "vcs", level: "info", title: "Select a commit in the Git log" });
      return;
    }
    const repo = commitRepo(c);
    if (repo) await focusRepo(repo);
    void fn(c);
  };
}

/** Paths an action on changes refers to: argument, else the change tree's selection (Commit window or Git › Local Changes). */
function changePaths(arg: unknown): string[] | undefined {
  if (Array.isArray(arg)) return arg.filter((x): x is string => typeof x === "string");
  if (typeof arg === "string") return [arg];
  const sel = useCommit.getState().selection;
  return commitWindowFocused() && sel.length ? sel : undefined;
}

/** A change list id: argument, else the list of the Commit tool window selection. */
function listArg(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  return useCommit.getState().selectedList ?? null;
}

function shelfArg(arg: unknown) {
  const shelves = useShelf.getState().shelves;
  const id = typeof arg === "string" ? arg : useCommit.getState().selectedShelf;
  return shelves.find((s) => s.id === id) ?? null;
}

async function checkoutCommit(c: Commit) {
  await checkoutDetached(c.id, c.shortId);
}

/** Keeps `vcsOperation` (rebase / merge / cherry-pick / revert / am / "") in sync for `when` clauses. */
export function trackOperationContext(): () => void {
  const sync = () => setContext("vcsOperation", inProgress() ?? "");
  sync();
  const off = useVcs.subscribe((s, p) => {
    if (s.branch?.operation !== p.branch?.operation) sync();
  });
  return () => {
    off();
    setContext("vcsOperation", "");
  };
}

export function registerHistoryActions(): () => void {
  const actions: Action[] = [
    // --- operation in progress (Git › Continue Rebase…) ---
    {
      id: "vcs.rebase.continue",
      title: "Continue Rebase",
      category: "Git",
      when: "vcsAvailable && vcsOperation == rebase",
      run: () => void controlOperation("continue", "rebase"),
    },
    {
      id: "vcs.rebase.abort",
      title: "Abort Rebase",
      category: "Git",
      when: "vcsAvailable && vcsOperation == rebase",
      run: () => void controlOperation("abort", "rebase"),
    },
    {
      id: "vcs.rebase.skip",
      title: "Skip Commit",
      category: "Git",
      when: "vcsAvailable && vcsOperation == rebase",
      keywords: ["rebase"],
      run: () => void controlOperation("skip", "rebase"),
    },
    {
      id: "vcs.merge.abort",
      title: "Abort Merge",
      category: "Git",
      when: "vcsAvailable && vcsOperation == merge",
      run: () => void controlOperation("abort", "merge"),
    },
    {
      id: "vcs.cherryPick.continue",
      title: "Continue Cherry-Pick",
      category: "Git",
      when: "vcsAvailable && vcsOperation == cherry-pick",
      run: () => void controlOperation("continue", "cherry-pick"),
    },
    {
      id: "vcs.cherryPick.abort",
      title: "Abort Cherry-Pick",
      category: "Git",
      when: "vcsAvailable && vcsOperation == cherry-pick",
      run: () => void controlOperation("abort", "cherry-pick"),
    },
    {
      id: "vcs.revert.continue",
      title: "Continue Revert",
      category: "Git",
      when: "vcsAvailable && vcsOperation == revert",
      run: () => void controlOperation("continue", "revert"),
    },
    {
      id: "vcs.revert.abort",
      title: "Abort Revert",
      category: "Git",
      when: "vcsAvailable && vcsOperation == revert",
      run: () => void controlOperation("abort", "revert"),
    },

    // --- Git menu ---
    { id: "vcs.newTag", title: "New Tag…", category: "Git", when: VCS, run: showTagDialog },
    {
      id: "vcs.resetHead",
      title: "Reset HEAD…",
      category: "Git",
      when: VCS,
      keywords: ["git reset"],
      run: () => showResetDialog(),
    },

    // --- Git Log toolbar ---
    {
      id: "vcs.log.goToRef",
      title: "Go to Hash/Branch/Tag",
      category: "Git Log",
      icon: "search",
      when: VCS,
      keyWhen: IN_GIT_LOG,
      keywords: ["find commit", "jump"],
      run: async () => {
        toolWindowService().show("git", true);
        const rev = await chooseRevision("Go to Hash/Branch/Tag", {
          tags: true,
          placeholder: "Enter hash or branch/tag name",
        });
        if (rev && !(await goToRef(rev)))
          notifications().notify({ group: "vcs", level: "warning", title: `'${rev}' was not found in the log` });
      },
    },

    // --- Git Log commit context menu ---
    {
      id: "vcs.log.copyRevision",
      title: "Copy Revision Number",
      category: "Git Log",
      icon: "copy",
      when: VCS,
      keyWhen: IN_GIT_LOG,
      run: withCommits((cs) => navigator.clipboard?.writeText(cs.map((c) => c.id).join(" "))),
    },
    {
      id: "vcs.log.createPatch",
      title: "Create Patch…",
      category: "Git Log",
      when: VCS,
      run: withCommits((cs) => showCreatePatchForCommits(cs)),
    },
    {
      id: "vcs.log.cherryPick",
      title: "Cherry-Pick",
      category: "Git Log",
      when: VCS,
      run: withCommits(cherryPick),
    },
    {
      id: "vcs.log.checkoutRevision",
      title: "Checkout Revision",
      category: "Git Log",
      when: VCS,
      run: withCommit(checkoutCommit),
    },
    {
      id: "vcs.log.compareWithLocal",
      title: "Compare with Local",
      category: "Git Log",
      icon: "diff",
      when: VCS,
      run: withCommit(showCompareWithLocal),
    },
    {
      id: "vcs.log.compareVersions",
      title: "Compare Versions",
      category: "Git Log",
      icon: "diff",
      when: VCS,
      run: withCommits((cs) => {
        if (cs.length !== 2) {
          notifications().notify({ group: "vcs", level: "info", title: "Select two commits to compare" });
          return;
        }
        // Newest first, as the log shows them.
        showCompareVersions(cs[1]!, cs[0]!);
      }),
    },
    {
      id: "vcs.log.resetToHere",
      title: "Reset Current Branch to Here…",
      category: "Git Log",
      when: VCS,
      run: withCommit((c) => showResetDialog(c)),
    },
    {
      id: "vcs.log.revert",
      title: "Revert Commit",
      category: "Git Log",
      icon: "revert",
      when: VCS,
      run: withCommits(revertCommits),
    },
    {
      id: "vcs.log.undoCommit",
      title: "Undo Commit…",
      category: "Git Log",
      icon: "undo",
      when: VCS,
      run: withCommit(undoCommit),
    },
    {
      id: "vcs.log.editMessage",
      title: "Edit Commit Message…",
      category: "Git Log",
      when: VCS,
      keywords: ["reword"],
      run: withCommit(editCommitMessage),
    },
    {
      id: "vcs.log.dropCommit",
      title: "Drop Commit",
      category: "Git Log",
      when: VCS,
      run: withCommits(dropCommits),
    },
    {
      id: "vcs.log.squashCommits",
      title: "Squash Commits…",
      category: "Git Log",
      when: VCS,
      run: withCommits(squashCommits),
    },
    {
      id: "vcs.log.fixup",
      title: "Fixup…",
      description: "Prepares a fixup! commit of the local changes for the selected commit.",
      category: "Git Log",
      when: VCS,
      run: withCommit((c) => prepareFixup(c, "fixup")),
    },
    {
      id: "vcs.log.squashInto",
      title: "Squash Into…",
      description: "Prepares a squash! commit of the local changes for the selected commit.",
      category: "Git Log",
      when: VCS,
      run: withCommit((c) => prepareFixup(c, "squash")),
    },
    {
      id: "vcs.log.pushUpToHere",
      title: "Push All up to Here…",
      category: "Git Log",
      icon: "git-push",
      when: VCS,
      run: withCommit((c) => {
        const head = useVcs.getState().branch?.head;
        if (head) void executeAction("vcs.push", { branch: head, revision: c });
      }),
    },
    {
      id: "vcs.log.rebaseOntoCommit",
      title: "Rebase Current Branch onto Selected Commit",
      category: "Git Log",
      when: VCS,
      run: withCommit((c) => rebaseOnto(c.id)),
    },
    {
      id: "vcs.log.goToChild",
      title: "Go to Child Commit",
      category: "Git Log",
      icon: "arrow-left",
      when: VCS,
      run: withCommit(goToChild),
    },
    {
      id: "vcs.log.goToParent",
      title: "Go to Parent Commit",
      category: "Git Log",
      icon: "arrow-right",
      when: VCS,
      run: withCommit(goToParent),
    },
    {
      id: "vcs.log.openInBrowser",
      title: "View in Browser",
      category: "Git Log",
      icon: "external-link",
      when: VCS,
      run: withCommit(openCommitInBrowser),
    },
    {
      id: "vcs.log.interactiveRebase",
      title: "Interactively Rebase from Here…",
      category: "Git Log",
      when: VCS,
      keywords: ["squash", "fixup", "reword", "reorder"],
      run: withCommit(interactivelyRebaseFrom),
    },
    {
      id: "vcs.log.newBranch",
      title: "New Branch…",
      category: "Git Log",
      icon: "branch",
      when: VCS,
      run: withCommit((c) => newBranch(c.id)),
    },
    {
      id: "vcs.log.newTag",
      title: "New Tag…",
      category: "Git Log",
      when: VCS,
      run: withCommit(newTagOn),
    },

    // --- change lists ---
    {
      id: "vcs.changelist.new",
      title: "New Changelist…",
      category: "Git",
      icon: "changelist",
      when: VCS,
      run: () => newChangelist(),
    },
    {
      id: "vcs.changelist.edit",
      title: "Edit Changelist…",
      category: "Git",
      when: VCS,
      keyWhen: IN_COMMIT,
      run: ({ arg }) => {
        const id = listArg(arg) ?? useChangelists.getState().state.active;
        editChangelist(id);
      },
    },
    {
      id: "vcs.changelist.delete",
      title: "Delete Changelist",
      category: "Git",
      when: VCS,
      run: ({ arg }) => {
        const id = listArg(arg);
        if (id) void deleteChangelist(id);
      },
    },
    {
      id: "vcs.changelist.setActive",
      title: "Set Active Changelist",
      category: "Git",
      when: VCS,
      run: ({ arg }) => {
        const id = listArg(arg);
        if (id) setActiveChangelist(id);
      },
    },
    {
      id: "vcs.changelist.move",
      title: "Move to Another Changelist…",
      category: "Git",
      when: VCS,
      keyWhen: IN_COMMIT,
      run: ({ arg }) => showMoveToChangelist(changePaths(arg) ?? []),
    },
    {
      id: "vcs.changelist.commit",
      title: "Commit Changelist…",
      category: "Git",
      icon: "commit",
      when: VCS,
      run: ({ arg }) => {
        commitChangelist(listArg(arg) ?? useChangelists.getState().state.active);
        openCommit();
      },
    },

    // --- shelf ---
    {
      id: "vcs.shelve",
      title: "Shelve Changes…",
      category: "Git",
      icon: "shelve",
      when: VCS,
      run: ({ arg }) => shelveChanges(changePaths(arg)),
    },
    { id: "vcs.showShelf", title: "Show Shelf", category: "Git", icon: "shelve", when: VCS, run: showShelf },
    {
      id: "vcs.unshelve",
      title: "Unshelve…",
      category: "Git",
      icon: "unshelve",
      when: VCS,
      run: ({ arg }) => {
        const entry = shelfArg(arg);
        if (entry) unshelve(entry);
        else showShelf();
      },
    },
    {
      id: "vcs.shelf.delete",
      title: "Delete Shelved Changes",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const entry = shelfArg(arg);
        if (entry) void deleteShelf(entry);
      },
    },
    {
      id: "vcs.shelf.rename",
      title: "Rename Shelved Changes…",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const entry = shelfArg(arg);
        if (entry) void renameShelf(entry);
      },
    },

    // --- patches ---
    {
      id: "vcs.createPatch",
      title: "Create Patch…",
      category: "Git",
      icon: "file-patch",
      when: VCS,
      run: ({ arg }) => showCreatePatchForChanges(changePaths(arg)),
    },
    {
      id: "vcs.applyPatch",
      title: "Apply Patch…",
      category: "Git",
      icon: "file-patch",
      when: VCS,
      run: ({ arg }) => void showApplyPatch("file", typeof arg === "string" ? arg : undefined),
    },
    {
      id: "vcs.applyPatchFromClipboard",
      title: "Apply Patch from Clipboard…",
      category: "Git",
      when: VCS,
      run: () => void showApplyPatch("clipboard"),
    },
  ];
  return registerActions(actions);
}
