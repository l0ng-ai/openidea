import type { Branch } from "@/bindings";
import { unfetchedBranch, type VcsState } from "./store";
import { outgoingCount } from "./syncCommits";

export interface BranchSyncSummary {
  ahead: number;
  behind: number;
  unfetched: boolean;
  incomingRepositories: number;
  outgoingRepositories: number;
}

export function summarizeBranchSync(
  branches: Iterable<readonly [string | null, Branch]>,
  observations?: VcsState["unfetched"],
): BranchSyncSummary {
  const summary = { ahead: 0, behind: 0, unfetched: false, incomingRepositories: 0, outgoingRepositories: 0 };
  for (const [root, branch] of branches) {
    if (branch.remote) continue;
    const ahead = outgoingCount(branch);
    summary.ahead += ahead;
    summary.behind += branch.behind;
    if (branch.behind > 0) summary.incomingRepositories++;
    if (ahead > 0) summary.outgoingRepositories++;
    if (!summary.unfetched && observations)
      summary.unfetched = !!unfetchedBranch(observations, root, branch.name, branch.trackedTip);
  }
  return summary;
}
