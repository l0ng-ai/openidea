/**
 * Applying a suggested change locally (`GHPRReviewCommentBodyViewModel.applySuggestionLocally`
 * / `commitSuggestion`, `GHSuggestedChangeApplier`): the suggestion becomes a patch of the
 * local file (`buildSuggestionPatch`) applied with `vcsApplyPatch`; "Commit…" then commits
 * just the suggestion's lines of that file (a partial commit of its hunks). The thread is
 * resolved afterwards when the viewer may. Progress shows in the tool window's banner.
 */
import { useEffect, useState } from "react";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import type { GHPullRequest, GHPullRequestReviewThread } from "../../api/types";
import { withBusy } from "../../data/local";
import { resolveThread } from "../../data/operations";
import { usePullRequestData } from "../../data/pullRequest";
import { buildSuggestionPatch, type SuggestionTarget } from "../model";

async function repositoryRoot(): Promise<string> {
  const roots = await call(commands.vcsRoots());
  const root = roots[0]?.root;
  if (!root) throw new Error("The project is not a Git repository");
  return String(root).replace(/[\\/]+$/, "");
}

/** Applies `suggestion` to the local file; with `commitMessage`, commits it. Whether it succeeded. */
export async function applySuggestion(
  number: number,
  thread: Pick<GHPullRequestReviewThread, "id" | "viewerCanResolve">,
  target: SuggestionTarget,
  suggestion: readonly string[],
  commitMessage?: string,
): Promise<boolean> {
  const title = commitMessage ? tx("Committing suggested change") : tx("Applying suggested change");
  const done = await withBusy(title, async () => {
    const root = await repositoryRoot();
    const abs = `${root}/${target.path}`;
    const text = await call(commands.fsReadText(abs));
    const { patch, start, lines } = buildSuggestionPatch(text, target, suggestion);
    const outcome = await call(commands.vcsApplyPatch(null, patch));
    const files = outcome.conflicts.join(", ");
    if (files) throw new Error(tx`Conflicts in ${files}`);
    if (commitMessage) {
      const head = (await call(commands.vcsFileAt(abs, "HEAD"))) ?? "";
      const disk = await call(commands.fsReadText(abs));
      const end = start + Math.max(lines, 1);
      const hunks = (await commands.vcsDiffHunks(head, disk))
        .filter((h) => h.start < end && h.start + Math.max(h.lines, 1) > start)
        .map(({ start, lines, oldStart, oldLines }) => ({ start, lines, oldStart, oldLines }));
      if (!hunks.length) throw new Error(tx`${target.path}: nothing to commit`);
      await call(
        commands.vcsCommit(null, commitMessage, {
          amend: false,
          signOff: false,
          author: null,
          runHooks: true,
          partial: [{ path: abs, hunks }],
        }),
      );
    }
    return true;
  });
  if (!done) return false;
  if (thread.viewerCanResolve) await withBusy(tx("Resolving thread"), () => resolveThread(number, thread.id));
  return true;
}

let branchCache: {
  at: number;
  value: Promise<{ head: string | null; upstream: string | null; commit: string | null }>;
} | null = null;

function branchInfo() {
  if (!branchCache || Date.now() - branchCache.at > 2000) {
    branchCache = {
      at: Date.now(),
      value: call(commands.vcsBranchInfo(null)).then(
        (b) => ({ head: b.head, upstream: b.upstream, commit: b.headCommit }),
        () => ({ head: null, upstream: null, commit: null }),
      ),
    };
  }
  return branchCache.value;
}

/** Whether the checked-out branch is the pull request's (it tracks its head branch, or is at its head). */
export function isReviewBranch(
  pr: Pick<GHPullRequest, "headRefName" | "headRefOid">,
  b: { head: string | null; upstream: string | null; commit: string | null },
): boolean {
  if (b.commit && b.commit === pr.headRefOid) return true;
  if (b.upstream) return b.upstream.slice(b.upstream.indexOf("/") + 1) === pr.headRefName;
  return b.head === pr.headRefName;
}

/** `isOnReviewBranch`, checked again when the window regains focus; null while unknown. */
export function useOnReviewBranch(number: number): boolean | null {
  const pr = usePullRequestData(number, "details").value;
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pr) return;
    let alive = true;
    const check = () => void branchInfo().then((b) => alive && setValue(isReviewBranch(pr, b)));
    check();
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
    };
  }, [pr]);
  return value;
}
