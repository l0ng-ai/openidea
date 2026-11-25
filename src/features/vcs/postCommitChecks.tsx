import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { upsertTaskSoon } from "@/workbench/tasks";
import { CommitCheckSummary } from "./CommitCheckSummary";
import { analyzeCommittedChanges } from "./commitAnalysis";
import type { CommitProblem } from "./commitChecks";
import type { CommitCheckResult } from "./commitCheckRegistry";
import { committedSnapshots } from "./commitContents";
import { checkCommittedTodos, type CommitTodoRules } from "./commitTodo";
import { runCommitTests } from "./commitTests";

interface PostCommitCheck {
  ids: string[];
  commits: Promise<string[]>;
  controller: AbortController;
  problems: CommitProblem[] | null;
}

interface CommitTestTarget {
  repo: string;
  id: string;
  replaced?: string | null;
}

interface PostCommitTests {
  targets: readonly CommitTestTarget[];
  controller: AbortController;
  problems: CommitProblem[] | null;
}

export const usePostCommitChecks = create<{
  repositories: ReadonlyMap<string, PostCommitCheck>;
  tests: PostCommitTests | null;
}>(() => ({
  repositories: new Map(),
  tests: null,
}));

const testNotificationKey = "vcs.postCommitTests";
let lastTestRun = Promise.resolve();

function forgetTests(controller: AbortController) {
  if (usePostCommitChecks.getState().tests?.controller !== controller) return;
  usePostCommitChecks.setState({ tests: null });
  controller.abort();
  notifications().expire?.(testNotificationKey);
}

const notificationKey = (repo: string) => `vcs.postCommitChecks:${repo}`;

function setCheck(repo: string, check?: PostCommitCheck) {
  usePostCommitChecks.setState((state) => {
    const repositories = new Map(state.repositories);
    if (check) repositories.set(repo, check);
    else repositories.delete(repo);
    return { repositories };
  });
}

function forgetCheck(repo: string, controller: AbortController) {
  if (usePostCommitChecks.getState().repositories.get(repo)?.controller !== controller) return;
  setCheck(repo);
  controller.abort();
  notifications().expire?.(notificationKey(repo));
}

export function installPostCommitChecks(): () => void {
  const clear = () => {
    const { repositories, tests } = usePostCommitChecks.getState();
    for (const [repo, check] of repositories) forgetCheck(repo, check.controller);
    if (tests) forgetTests(tests.controller);
  };
  const unsubscribe = useProject.subscribe((current, previous) => {
    if (current.project !== previous.project) clear();
  });
  return () => {
    unsubscribe();
    clear();
  };
}

/** Consecutive commits get a single review of the resulting changes. */
async function commitsToCheck(repo: string, id: string, previous: string[], replaced: string | null) {
  if (!previous.length) return [id];
  const prior = replaced === previous.at(-1) ? previous.slice(0, -1) : previous;
  if (!prior.length) return [id];
  const commits = await call(
    commands.vcsLog(repo, {
      branch: id,
      path: null,
      author: null,
      text: null,
      skip: 0,
      limit: 1,
    }),
  ).catch(() => []);
  return commits[0]?.id === id && commits[0].parents[0] === prior.at(-1) ? [...prior, id] : [id];
}

/** Synchronous checks take over an in-flight test check before launching their own run. */
export async function stopPendingPostCommitTests() {
  const tests = usePostCommitChecks.getState().tests;
  if (tests && !tests.problems) forgetTests(tests.controller);
  await lastTestRun;
}

/** One Run configuration for the entire commit, even when it spans Git roots. */
export function startPostCommitTests(
  targets: readonly CommitTestTarget[],
  selection: Parameters<typeof runCommitTests>[0],
) {
  const previous = usePostCommitChecks.getState().tests;
  if (previous) forgetTests(previous.controller);
  const controller = new AbortController();
  const active = () => usePostCommitChecks.getState().tests?.controller === controller && !controller.signal.aborted;
  const task = {
    id: `vcs.postCommitTests:${JSON.stringify(targets.map(({ repo, id }) => [repo, id]))}`,
    title: tx("Running post-commit tests"),
    message: selection.name,
    fraction: null,
    cancel: () => forgetTests(controller),
  };
  lastTestRun = lastTestRun.then(async () => {
    let problems: CommitProblem[];
    try {
      if (!active()) return;
      const related = await Promise.all(
        targets.map(async ({ repo, id, replaced }) => {
          const prior = (previous?.targets ?? []).filter((target) => target.repo === repo).map((target) => target.id);
          const ids = await commitsToCheck(repo, id, prior, replaced ?? null);
          return ids.map((id) => ({ repo, id }));
        }),
      );
      if (!active()) return;
      const otherRoots = (previous?.targets ?? []).filter((old) => !targets.some(({ repo }) => repo === old.repo));
      usePostCommitChecks.setState({ tests: { ...check, targets: [...otherRoots, ...related.flat()] } });
      const result = await runCommitTests(selection, controller.signal);
      problems = result ? [{ title: "Run Tests", text: result.text, details: result.fix }] : [];
    } catch (error) {
      if (!active()) return;
      problems = [checkFailure("Run Tests", error)];
    } finally {
      upsertTaskSoon({ ...task, done: true });
    }
    if (!active()) return;
    if (!problems.length) {
      forgetTests(controller);
      return;
    }
    const current = usePostCommitChecks.getState().tests!;
    usePostCommitChecks.setState({ tests: { ...current, problems } });
    notifyFailure(testNotificationKey, problems, () => forgetTests(controller));
  });
  const check: PostCommitTests = { targets, controller, problems: null };
  usePostCommitChecks.setState({ tests: check });
  upsertTaskSoon({ ...task, done: false });
}

function notifyFailure(key: string, problems: CommitProblem[], ignore: () => void) {
  notifications().notify({
    key,
    title: "Post-commit checks failed",
    level: "warning",
    group: "vcs",
    sticky: true,
    body: <CommitCheckSummary result={{ problems, blocked: false }} />,
    actions: [{ label: "Ignore", run: ignore }],
  });
}

function checkFailure(title: string, error: unknown): CommitProblem {
  const message = error instanceof Error ? error.message : String(error);
  return { title, text: tx`The check could not run: ${message}` };
}

export async function startPostCommitChecks(
  repo: string,
  id: string,
  settings: { analyzeCode: boolean; todo: CommitTodoRules | null },
  replaced: string | null = null,
) {
  const project = useProject.getState().project;
  if (!project) return;
  const previous = usePostCommitChecks.getState().repositories.get(repo);
  if (previous?.ids.at(-1) === id) return;
  if (previous) forgetCheck(repo, previous.controller);
  const controller = new AbortController();
  const commits = (previous?.commits ?? Promise.resolve([])).then((ids) => commitsToCheck(repo, id, ids, replaced));
  const check: PostCommitCheck = { ids: [id], commits, controller, problems: null };
  setCheck(repo, check);
  const active = () =>
    !controller.signal.aborted &&
    useProject.getState().project === project &&
    usePostCommitChecks.getState().repositories.get(repo)?.controller === controller;
  const task = {
    id: `vcs.postCommitChecks:${repo}:${id}`,
    title: tx("Running post-commit checks"),
    message: null,
    fraction: null,
    cancel: () => forgetCheck(repo, controller),
  };
  upsertTaskSoon({ ...task, done: false });
  const run = async (title: string, check: () => Promise<CommitCheckResult | null>): Promise<CommitProblem | null> => {
    try {
      const result = await check();
      if (!result) return null;
      const fix = result.fix;
      return {
        title,
        text: result.text,
        details: fix && {
          label: fix.label,
          run: () => {
            if (active()) void fix.run();
          },
        },
      };
    } catch (error) {
      return checkFailure(title, error);
    }
  };
  let problems;
  try {
    const ids = await commits;
    if (!active()) return;
    setCheck(repo, { ...check, ids });
    const snapshots = await committedSnapshots(repo, ids, controller.signal);
    const jobs: Array<Promise<CommitProblem | null>> = [];
    if (settings.analyzeCode)
      jobs.push(run("Code analysis", () => analyzeCommittedChanges(snapshots, controller.signal)));
    const todo = settings.todo;
    if (todo) jobs.push(run("TODO", () => checkCommittedTodos(snapshots, controller.signal, todo, id)));
    problems = (await Promise.all(jobs)).filter((problem) => problem !== null);
  } catch (error) {
    problems = [checkFailure("Commit Checks", error)];
  } finally {
    upsertTaskSoon({ ...task, done: true });
  }
  if (!active()) return;
  if (!problems.length) {
    forgetCheck(repo, controller);
    return;
  }
  const current = usePostCommitChecks.getState().repositories.get(repo)!;
  setCheck(repo, { ...current, problems });
  notifyFailure(notificationKey(repo), problems, () => forgetCheck(repo, controller));
}
