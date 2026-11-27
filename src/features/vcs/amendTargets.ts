import type { Commit, HistoryTip } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { isProtectedRemoteBranch } from "./branches";

export const SELECT_AMEND_TARGET = "vcs.selectAmendTarget";

export interface EarlierAmend {
  root: string;
  head: HistoryTip;
  commit: Commit;
}

export interface AmendTargets {
  latest: Commit | null;
  earlier: EarlierAmend[];
}

export async function protectedAmendBranches(root: string): Promise<string[]> {
  return (await call(commands.vcsBranches(root))).filter(isProtectedRemoteBranch).map((branch) => branch.name);
}

/** Recent first-parent commits up to the nearest merge or protected remote ancestor. */
export async function loadAmendTargets(root: string): Promise<AmendTargets> {
  const branch = await call(commands.vcsBranchInfo(root));
  if (!branch.headCommit || branch.operation) return { latest: null, earlier: [] };
  const head = { branch: branch.head, commit: branch.headCommit };
  const [history, protectedBranches] = await Promise.all([
    call(
      commands.vcsLog(root, {
        branch: head.commit,
        path: null,
        author: null,
        text: null,
        skip: 0,
        limit: 20,
        order: "topo",
        firstParent: true,
      }),
    ),
    protectedAmendBranches(root),
  ]);
  const latest = history[0];
  if (latest?.id !== head.commit) return { latest: null, earlier: [] };
  const published = new Set(
    await Promise.all(
      protectedBranches.map((name) => call(commands.vcsMergeBase(root, head.commit, `refs/remotes/${name}`))),
    ),
  );
  const cutoff = history.findIndex((commit) => commit.parents.length > 1 || published.has(commit.id));
  const earlier = history.slice(1, cutoff < 0 ? history.length : cutoff).map((commit) => ({ root, head, commit }));
  return { latest, earlier };
}
