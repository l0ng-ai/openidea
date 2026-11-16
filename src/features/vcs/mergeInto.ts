/**
 * Merge dialog: merges `source` into the branch picked as the target, checking that
 * target out first (and pushing it back when it is a remote branch).
 */
import type { Branch, MergeOptions } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { checkoutBranch, conflictActions, openConflictsInstead } from "./branchOps";
import { localBranchFor, pushesTarget, type MergeTarget } from "./mergeRequest";
import { runOp, runRemote, saveAll } from "./ops";
import { refreshNow, useVcs } from "./store";

export interface MergeIntoRequest {
  repo: string | null;
  /** Branch whose commits are merged in. */
  source: string;
  target: MergeTarget;
  options: MergeOptions;
  /** The target repository's branches, as the window listed them. */
  branches: readonly Branch[];
  /** Fetch first, so a remote target is merged as it is on the server, not as last seen. */
  fetch: boolean;
}

/** Runs the merge; `true` once it landed on the target (a push failure is reported, not fatal). */
export async function mergeIntoTarget({
  repo,
  source,
  target,
  options,
  branches,
  fetch: fetchFirst,
}: MergeIntoRequest): Promise<boolean> {
  const local = localBranchFor(target);
  await saveAll();

  // A remote target is merged in the state the server has, not the one this clone last saw.
  if (fetchFirst && target.kind === "remote") {
    const fetched = await runRemote({ op: "fetch" }, tx`Fetching ${target.remote}`, [repo]);
    if (!fetched) return false;
  }

  // A remote target merges on its local namesake, which is checked out first (created
  // as a tracking branch when the repository has no local one yet).
  if (local) {
    const exists = branches.some((b) => !b.remote && b.name === local);
    if (exists) await checkoutBranch(local);
    else {
      const created = await runOp(tx`Create branch ${local}`, () =>
        call(commands.vcsCreateBranch(repo, local, target.kind === "remote" ? target.name : null, true, false)),
      );
      if (created === undefined) return false;
    }
    await refreshNow();
  }

  const label = local ?? useVcs.getState().branch?.head ?? "HEAD";
  const merged = await runOp(
    tx`Merge ${source} into ${label}`,
    () => call(commands.vcsMergeWith(repo, [source], options)),
    { success: tx`Merged ${source} into ${label}`, errorActions: conflictActions, onError: openConflictsInstead },
  );
  if (merged === undefined) return false;

  if (pushesTarget(target) && target.kind === "remote" && local)
    await runRemote(
      {
        op: "pushBranch",
        branch: local,
        revision: null,
        force_with_lease: false,
        remote: target.remote,
        set_upstream: true,
      },
      `${local} → ${target.name}`,
      [repo],
    );

  await refreshNow();
  return true;
}

/** The repository's URL for remote `origin`-like `remote`, read from its Git config. */
export async function remoteUrlOf(repo: string | null, remote: string): Promise<string | null> {
  return (await call(commands.vcsConfigGet(repo, `remote.${remote}.url`)).catch(() => null)) || null;
}
