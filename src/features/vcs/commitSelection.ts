/**
 * What Commit would commit, as one value per repository (`CommitSelection`): what
 * `commitChanges` commits, what plugins read through `commit.pending-commit` and what
 * contributed before-commit checks run on. Its `revision` changes with the message,
 * Amend and the inclusion, so a plugin's message never replaces newer typing.
 */
import type { CommitOptions, CommitSelection, FileStatus, PartialCommitFile, PartialCommitHunk } from "@/bindings";
import { EditorView } from "@codemirror/view";
import { registerEditorContribution } from "@/editor/api";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import {
  maybeEditorService,
  provideCommitService,
  useCommitCheckProviders,
  type CommitChanges,
} from "@/workbench/contributions";
import { commitRepos, planCommit, type CommitPlan } from "./changes";
import type { CommitProblem } from "./commitChecks";
import { useChangelists } from "./changelists";
import { protectedAmendBranches } from "./amendTargets";
import { inclusionChecks, stagedRepositories, stagedRepositoryScope, stagingAreaOn, statusForCommit } from "./staging";
import { sameCommitDraft, useCommit } from "./commitStore";
import { currentHunkText, hunkKeys } from "./hunks";
import { baseName, rootOf, stripSlash } from "./model";
import { saveAll } from "./ops";
import { currentRepo, refreshNow, useVcs, type VcsState } from "./store";
import { staleDiff } from "./stagingDiffEdits";

let revision = 1;

/** The draft's revision: bumped whenever the message, Amend or the inclusion changes. */
export const draftRevision = () => revision;

function sameStatus(a: readonly FileStatus[], b: readonly FileStatus[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((entry, i) => {
        const other = b[i]!;
        return (
          entry.path === other.path &&
          entry.staged === other.staged &&
          entry.unstaged === other.unstaged &&
          entry.renamedFrom === other.renamedFrom
        );
      }))
  );
}

function commitTargetsChanged(current: VcsState, previous: VcsState): boolean {
  if (current.heads === previous.heads && current.operations === previous.operations) return false;
  const changed = current.roots.filter((root) => {
    const head = current.heads[root];
    const before = previous.heads[root];
    return (
      head?.head !== before?.head ||
      head?.headCommit !== before?.headCommit ||
      head?.interactiveRebase !== before?.interactiveRebase ||
      current.operations[root] !== previous.operations[root]
    );
  });
  if (!changed.length) return false;
  return currentPlan().repositories.some((repo) => {
    const root = repo ?? current.roots[0] ?? current.root;
    return !!root && changed.includes(root);
  });
}

export function installDraftRevision(): () => void {
  const invalidateReview = () => {
    const review = useCommit.getState().checkResult;
    if (review && !review.stale)
      useCommit.setState({ checkResult: review.problems.length ? { ...review, stale: true } : null });
  };
  const offCommit = useCommit.subscribe((s, p) => {
    if (!sameCommitDraft(s, p)) {
      revision++;
      invalidateReview();
    }
  });
  const offLists = useChangelists.subscribe(() => {
    revision++;
    invalidateReview();
  });
  const offDefault = onWorkflowSettingsChange(
    (s) => s.vcs.commit.includeChangesByDefault,
    () => void revision++,
  );
  const offRepo = useVcs.subscribe((s, p) => {
    // With the staging area the index is the inclusion: a status change may change the commit.
    if (s.root !== p.root || (s.status !== p.status && stagingAreaOn())) revision++;
    if (s.status !== p.status || s.roots !== p.roots) {
      const { excludedStagedRepos } = useCommit.getState();
      if (excludedStagedRepos.size) {
        const staged = stagedRepositories(s.status, s.roots);
        const present = [...excludedStagedRepos].filter((repo) => staged.has(repo));
        if (present.length !== excludedStagedRepos.size) useCommit.setState({ excludedStagedRepos: new Set(present) });
      }
    }
    if (!useCommit.getState().checkResult) return;
    if (s.root !== p.root) useCommit.setState({ checkResult: null });
    else if (
      s.repo !== p.repo ||
      s.roots !== p.roots ||
      s.branch?.headCommit !== p.branch?.headCommit ||
      !sameStatus(s.status, p.status) ||
      commitTargetsChanged(s, p)
    )
      invalidateReview();
  });
  const offFiles = onIdeEvent("fsChanged", (event) => {
    if (!useCommit.getState().checkResult) return;
    const changed = new Set([...event.created, ...event.modified, ...event.removed].map(stripSlash));
    if (currentPlan().included.some((file) => changed.has(stripSlash(file.path)))) invalidateReview();
  });
  const offEditor = registerEditorContribution({
    id: "vcs.commitChecks",
    extensions: ({ path }) =>
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged &&
          useCommit.getState().checkResult &&
          currentPlan().included.some((file) => stripSlash(file.path) === path)
        )
          invalidateReview();
      }),
  });
  const offSettings = onWorkflowSettingsChange((s) => s.vcs, invalidateReview);
  return () => {
    offCommit();
    offLists();
    offDefault();
    offRepo();
    offFiles();
    offEditor();
    offSettings();
  };
}

interface PlannedCommit extends CommitPlan {
  repositories: Array<string | null>;
  stagedRepositorySelection: boolean;
}

/** The included changes and their target repositories from a single status snapshot. */
export function currentPlan(): PlannedCommit {
  const { status, root, roots } = useVcs.getState();
  const { checks: overrides, groupByRepo, excludedStagedRepos } = useCommit.getState();
  const staging = stagingAreaOn();
  const scope = stagedRepositoryScope(status, roots, staging && groupByRepo);
  const files = statusForCommit(status, roots, scope, excludedStagedRepos);
  const checks = inclusionChecks(files, root ?? "", useChangelists.getState().state, overrides, staging);
  const plan = planCommit(files, checks, workflowSettings().vcs.commit.includeChangesByDefault);
  return {
    ...plan,
    repositories: scope && !plan.included.length ? [] : commitRepos(plan.included, roots, currentRepo()),
    stagedRepositorySelection: scope !== null,
  };
}

/**
 * The included blocks of files committed partially, as hunk ranges against HEAD of the
 * text on disk (saved just before). A file whose blocks are all included again (e.g. it
 * was edited since) is committed whole.
 */
async function partialCommitFiles(paths: readonly string[]): Promise<{ files: PartialCommitFile[]; whole: string[] }> {
  const files: PartialCommitFile[] = [];
  const whole: string[] = [];
  const { excludedHunks, excludedHunkLines } = useCommit.getState();
  for (const path of paths) {
    const [head, disk] = await Promise.all([call(commands.vcsFileAt(path, "HEAD")), call(commands.fsReadText(path))]);
    const text = disk.replace(/\r\n?/g, "\n");
    const hunks = await commands.vcsDiffHunks(head ?? "", text);
    const keys = hunkKeys(text, hunks);
    const excluded = excludedHunks.get(path) ?? excludedHunks.get(`${path}/`);
    const linesByHunk = excludedHunkLines.get(path) ?? excludedHunkLines.get(`${path}/`);
    if (linesByHunk && [...linesByHunk.keys()].some((key) => !keys.includes(key))) throw staleDiff();
    const lineHunks: PartialCommitHunk[] = [];
    const chosen = hunks.flatMap((h, i) => {
      const key = keys[i]!;
      if (excluded?.has(key)) return [];
      const { start, lines, oldStart, oldLines } = h;
      const range = { start, lines, oldStart, oldLines };
      const selection = linesByHunk?.get(key);
      if (!selection) return [range];
      lineHunks.push({
        range,
        oldText: h.oldText,
        newText: currentHunkText(text, h),
        deletions: includedOffsets(oldLines, selection.old),
        additions: includedOffsets(lines, selection.current),
      });
      return [];
    });
    if (chosen.length === hunks.length) whole.push(path);
    else files.push({ path, hunks: chosen, ...(lineHunks.length ? { lineHunks } : {}) });
  }
  return { files, whole };
}

function includedOffsets(count: number, excluded: ReadonlySet<number>): number[] {
  return Array.from({ length: count }, (_, line) => line).filter((offset) => !excluded.has(offset));
}

/**
 * `plan` per repository with the Commit Options, as `vcs_commit` gets it. Read from disk:
 * the caller saved the editors and refreshed the status.
 */
export async function selectionOf(plan: PlannedCommit): Promise<CommitSelection> {
  const rev = revision;
  const { message, amend, amendTarget, signOff, author, authorDate, runHooks } = useCommit.getState();
  const roots = useVcs.getState().roots;
  const fallback = useVcs.getState().root ?? "";
  const partial = await partialCommitFiles(plan.partial);
  const repos = plan.repositories;
  if (amend && amendTarget && (repos.length !== 1 || (repos[0] ?? fallback) !== amendTarget.root)) {
    throw new Error(tx("The repository for the amend target has changed."));
  }
  const target =
    amend && amendTarget
      ? {
          commit: amendTarget.commit.id,
          head: amendTarget.head,
          protectedBranches: await protectedAmendBranches(amendTarget.root),
        }
      : null;
  // The commit is made from a copy of the index, so changes left out keep their
  // staged state and the other repositories' indexes stay as they are.
  const stage = [...plan.stage, ...partial.whole];
  const repositories = repos.map((repo) => {
    // A path in another known repository never goes to this one, even when it is the only one committed.
    const inRepo = (path: string) => {
      const root = rootOf(path, roots);
      return root === null ? repos.length === 1 : root === repo;
    };
    const options: CommitOptions = {
      amend,
      ...(target && { amendTarget: target }),
      signOff,
      author: author.trim() || null,
      ...(authorDate && { authorDate }),
      runHooks,
      partial: partial.files.filter((f) => inRepo(f.path)),
      stage: stage.filter(inRepo),
      exclude: plan.exclude.filter(inRepo),
    };
    return { root: repo ?? fallback, options };
  });
  return { revision: rev, message: message.trim(), amend, repositories };
}

/** For plugins: what Commit would commit now (saving the editors as Commit does). */
async function pendingSelection(): Promise<CommitSelection | null> {
  if (!useVcs.getState().root) return null;
  await saveAll();
  await refreshNow();
  if (!useVcs.getState().root) return null;
  const rev = revision;
  const selection = await selectionOf(currentPlan());
  // Typing while the blocks were read: report the revision the snapshot started from.
  return { ...selection, revision: rev };
}

/** What Commit would commit now, one patch per repository: the staged or chosen blocks only. */
async function pendingChanges(): Promise<CommitChanges | null> {
  if (!useVcs.getState().root) return null;
  await saveAll();
  await refreshNow();
  if (!useVcs.getState().root) return null;
  const rev = revision;
  const plan = currentPlan();
  if (!plan.included.length) return { revision: rev, roots: [], patch: "" };
  const selection = await selectionOf(plan);
  const patches: string[] = [];
  for (const { root, options } of selection.repositories) {
    const patch = await call(commands.vcsPendingPatch(root, options));
    if (patch.trim()) patches.push(patch);
  }
  return { revision: rev, roots: selection.repositories.map((r) => r.root), patch: patches.join("\n") };
}

export function provideCommit(): () => void {
  provideCommitService({
    selection: pendingSelection,
    changes: pendingChanges,
    revision: draftRevision,
    setMessage: (rev, message) => {
      if (rev !== revision || !useVcs.getState().root) return false;
      useCommit.setState({ message });
      return true;
    },
  });
  return () => provideCommitService(undefined);
}

/** Problems of the contributed before-commit checks that are turned on. */
export async function contributedCheckProblems(selection: CommitSelection): Promise<CommitProblem[]> {
  const off = new Set(workflowSettings().vcs.commit.disabledPluginChecks);
  const problems: CommitProblem[] = [];
  for (const provider of useCommitCheckProviders.getState().providers) {
    const keys = provider
      .checks()
      .map((c) => c.key)
      .filter((k) => !off.has(k));
    if (!keys.length) continue;
    for (const p of await provider.run(selection, keys)) {
      const at = p.path ? `${baseName(p.path)}${p.line === undefined ? "" : `:${p.line + 1}`}` : null;
      const path = p.path;
      problems.push({
        title: p.title,
        text: p.message,
        details: path
          ? {
              label: at ?? "Show",
              run: () =>
                void maybeEditorService()?.openFile(path, {
                  selection: p.line === undefined ? undefined : { line: p.line, col: 0 },
                  focus: true,
                }),
            }
          : undefined,
      });
    }
  }
  return problems;
}
