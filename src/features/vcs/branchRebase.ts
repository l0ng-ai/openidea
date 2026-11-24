import type { Branch, BranchRebasePlan, CheckoutRebasePlan, HistoryTip, RebaseState } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { branchRef } from "./branchOps";
import { conflictsInstead, rebaseFeedback } from "./operations";
import { describeOperation, logConsole, runGitOperationWith, runOp, startShelfBatch } from "./ops";
import { currentRepoRoot, refreshNow, repoName } from "./store";

type TargetBranch = Pick<Branch, "name" | "remote">;

export interface BranchRebaseTarget {
  branch: TargetBranch;
  repos: readonly (string | null)[];
}

export function branchRebaseProblem(branch: TargetBranch, head: string | null) {
  if (!head) return tx("Rebase requires a checked-out branch");
  if (!branch.remote && head === branch.name) return tx`Branch '${branch.name}' is already the current branch`;
  return null;
}

export interface PlannedRebase {
  root: string;
  operation: { op: "rebaseBranch"; plan: BranchRebasePlan } | { op: "checkoutRebase"; plan: CheckoutRebasePlan };
  state: RebaseState;
}

interface RebaseFeedback {
  progress: string;
  success: string;
  failure: string;
  onRebased?: (entry: PlannedRebase) => void;
}

interface BranchRebaseSession {
  state: RebaseState;
  ready: Promise<void>;
  completedRoots: readonly string[];
  active: () => boolean;
  resume: (head: HistoryTip) => Promise<void>;
  abort: (rollback: boolean) => Promise<void>;
  dispose: () => void;
}

const paused = new Map<string, BranchRebaseSession>();

export async function pausedBranchRebase(root: string): Promise<BranchRebaseSession | undefined> {
  const session = paused.get(root);
  if (!session) return;
  await session.ready;
  const state = (await call(commands.vcsBranchInfo(root)).catch(() => null))?.rebase;
  if (session.active() && state && sameRebase(state, session.state)) return session;
  session.dispose();
}

function sameRebase(a: RebaseState, b: RebaseState): boolean {
  return a.onto === b.onto && a.original.branch === b.original.branch && a.original.commit === b.original.commit;
}

export async function rebaseOntoBranch({ branch, repos }: BranchRebaseTarget): Promise<void> {
  const project = useProject.getState().project;
  const roots = branchRebaseRoots(repos);
  if (!project || !roots.length) return;
  const label = branch.name;
  const target = branchRef(label, branch.remote);
  const plans = await runOp(
    tx`Rebase onto ${label}`,
    () =>
      Promise.all(
        roots.map(async (root): Promise<PlannedRebase> => {
          const [head, branches] = await Promise.all([
            call(commands.vcsBranchInfo(root)),
            call(commands.vcsBranches(root)),
          ]);
          const problem = branchRebaseProblem(branch, head.head);
          if (problem) throw new Error(`${repoName(root)} — ${problem}`);
          if (head.operation) throw new Error(tx`Finish the Git operation in ${repoName(root)} before rebasing`);
          if (!head.headCommit) throw new Error(tx("Rebase requires an existing commit"));
          const onto = branches.find((item) => item.name === label && item.remote === branch.remote)?.commit;
          if (!onto) throw new Error(tx`Branch '${label}' is no longer available`);
          const original = { branch: head.head, commit: head.headCommit };
          return {
            root,
            operation: { op: "rebaseBranch", plan: { target, onto, head: original } },
            state: { original, onto },
          };
        }),
      ),
    { refresh: false },
  );
  if (!plans || useProject.getState().project !== project) return;
  await runBranchRebases(plans, {
    progress: tx`Rebasing onto ${label}`,
    success: tx`Rebased onto ${label}`,
    failure: tx("Rebase failed"),
  });
}

export function branchRebaseRoots(repos: readonly (string | null)[]): string[] {
  const fallback = currentRepoRoot();
  return [...new Set(repos.map((repo) => repo ?? fallback))].filter((repo): repo is string => repo !== null);
}

export async function runBranchRebases(plans: readonly PlannedRebase[], feedback: RebaseFeedback): Promise<void> {
  const project = useProject.getState().project;
  if (!project || !plans.length) return;
  const active = () => useProject.getState().project === project;
  const completed = new Map<PlannedRebase, HistoryTip>();
  let index = 0;
  const record = (entry: PlannedRebase, after: HistoryTip) => {
    if (entry.operation.op === "checkoutRebase" || after.commit !== entry.state.original.commit) {
      completed.set(entry, after);
    }
    feedback.onRebased?.(entry);
  };
  const rollback = async () => {
    for (const [{ root, state, operation }, after] of [...completed.entries()].reverse()) {
      if (!active()) break;
      const repo = repoName(root);
      const checkout = operation.op === "checkoutRebase" ? operation.plan.base : null;
      await runOp(tx`Rollback (${repo})`, () =>
        call(commands.vcsRestoreHead(root, state.original.commit, after.commit, state.original.branch, checkout)),
      );
    }
  };
  const registerPause = async (entry: PlannedRebase, ready: Promise<void>) => {
    const { root } = entry;
    if (!active()) return false;
    const state = (await call(commands.vcsBranchInfo(root)).catch(() => null))?.rebase;
    if (!active() || !state || !sameRebase(state, entry.state)) return false;
    paused.get(root)?.dispose();
    const dispose = () => {
      if (paused.get(root) === session) paused.delete(root);
      off();
    };
    const session: BranchRebaseSession = {
      state,
      ready,
      completedRoots: [...completed.keys()].map((entry) => entry.root),
      active: () => active() && paused.get(root) === session,
      async resume(head) {
        if (!session.active()) return;
        dispose();
        if (head.branch !== state.original.branch) return;
        record(entry, head);
        index++;
        await run();
      },
      async abort(undo) {
        if (!session.active()) return;
        dispose();
        if (undo) await rollback();
      },
      dispose,
    };
    const off = useProject.subscribe(() => {
      if (!active()) dispose();
    });
    paused.set(root, session);
    return true;
  };
  const run = async () => {
    if (!active()) return;
    const batch = startShelfBatch(plans.slice(index).map(({ root }) => root));
    let attempted: PlannedRebase | undefined;
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let stopped = false;
    let cancelled = false;
    let success = false;
    let restoreError: string | null = null;
    try {
      success = await runGitOperationWith(
        null,
        {
          progress: feedback.progress,
          success: null,
          failure: feedback.failure,
          onError: async () => {
            if (!attempted || !active()) return false;
            stopped = await registerPause(attempted, ready);
            if (stopped) return true;
            const { root } = attempted;
            return conflictsInstead(root);
          },
        },
        async ({ request, output, cancelled: shouldCancel }) => {
          try {
            for (; index < plans.length && active() && !shouldCancel(); index++) {
              attempted = plans[index]!;
              const { root, operation } = attempted;
              const op = { ...operation, shelfBatch: batch.id };
              logConsole("cmd", `git ${describeOperation(op, root)}${plans.length > 1 ? ` (${repoName(root)})` : ""}`);
              const result = await call(commands.vcsOperation(root, request, op, output()));
              if (!result || !("rebased" in result) || !result.rebased)
                throw new Error(tx("The rebase result is unavailable"));
              record(attempted, result.rebased);
              attempted = undefined;
            }
          } finally {
            cancelled = shouldCancel();
          }
          return null;
        },
      );
    } finally {
      restoreError = await batch.finish().finally(settle);
    }
    if (!active()) return;
    if (attempted && (stopped || (await registerPause(attempted, ready)))) {
      await refreshNow();
      if (!(await conflictsInstead(attempted.root))) {
        rebaseFeedback(attempted.root, { progress: "", success: null, failure: "" }).reportPause?.(cancelled);
      }
      return;
    }
    if (restoreError !== null) return;
    if (success && index === plans.length) {
      notifications().notify({ group: "vcs", level: "info", title: feedback.success });
      return;
    }
    if (!completed.size) return;
    const repositories = [...completed.keys()].map(({ root }) => repoName(root)).join(", ");
    const result = await ask({
      title: "Rollback",
      body: tx`Roll back the rebase in ${repositories}?`,
      icon: "warning",
      buttons: [
        { id: "rollback", label: "Rollback", primary: true },
        { id: "keep", label: "Don't Rollback" },
      ],
    });
    if (result.button === "rollback") await rollback();
  };
  await run();
}
