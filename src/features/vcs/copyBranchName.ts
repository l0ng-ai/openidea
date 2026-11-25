/**
 * Copy Branch Name (IntelliJ's `Vcs.CopyCurrentBranchName`): the current branch of the
 * repository the action applies to, from Search Everywhere, a shortcut or VCS Operations.
 */
import type { Action } from "@/platform/actions";
import { operationRepo } from "./actions";
import { copyWithHint } from "./copyRepositoryPath";
import { currentRepoRoot, useVcs } from "./store";

/** The checked-out branch of the repository `arg` points at (else the active file's, else the selected one); null when detached. */
export function branchToCopy(arg?: unknown): string | null {
  const repo = operationRepo(arg) ?? currentRepoRoot();
  return (repo && useVcs.getState().heads[repo]?.head) || null;
}

export const copyBranchNameActions: Action[] = [
  {
    id: "vcs.copyBranchName",
    title: "Copy Branch Name",
    category: "Git",
    icon: "copy",
    when: "vcsAvailable",
    keywords: ["git", "branch", "clipboard", "current branch"],
    enabled: ({ arg }) => branchToCopy(arg) != null,
    run: ({ arg }) => {
      const branch = branchToCopy(arg);
      if (branch) void copyWithHint(branch);
    },
  },
];
