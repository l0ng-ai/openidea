/**
 * What Commit would commit, as one value per repository (`CommitSelection`): what
 * `commitChanges` commits, what plugins read through `commit.pending-commit` and what
 * contributed before-commit checks run on. Its `revision` changes with the message,
 * Amend and the inclusion, so a plugin's message never replaces newer typing.
 */
import type { CommitOptions, CommitSelection, PartialCommitFile } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { maybeEditorService, provideCommitService, useCommitCheckProviders } from "@/workbench/contributions";
import { commitRepos, planCommit, type CommitPlan } from "./changes";
import type { CommitProblem } from "./commitChecks";
import { useChangelists, withListDefaults } from "./changelists";
import { useCommit } from "./commitStore";
import { hunkKeys } from "./hunks";
import { baseName, rootOf } from "./model";
import { saveAll } from "./ops";
import { currentRepo, refreshNow, useVcs } from "./store";

let revision = 1;

/** The draft's revision: bumped whenever the message, Amend or the inclusion changes. */
export const draftRevision = () => revision;

export function installDraftRevision(): () => void {
  const offCommit = useCommit.subscribe((s, p) => {
    if (s.message !== p.message || s.amend !== p.amend || s.checks !== p.checks || s.excludedHunks !== p.excludedHunks)
      revision++;
  });
  const offLists = useChangelists.subscribe(() => void revision++);
  const offRepo = useVcs.subscribe((s, p) => {
    if (s.root !== p.root) revision++;
  });
  return () => {
    offCommit();
    offLists();
    offRepo();
  };
}

/** The included changes, as the status (refreshed by the caller) and the checkboxes say. */
export function currentPlan(): CommitPlan {
  const { status, root } = useVcs.getState();
  const checks = withListDefaults(status, root ?? "", useChangelists.getState().state, useCommit.getState().checks);
  return planCommit(status, checks);
}

/**
 * The included blocks of files committed partially, as hunk ranges against HEAD of the
 * text on disk (saved just before). A file whose blocks are all included again (e.g. it
 * was edited since) is committed whole.
 */
async function partialCommitFiles(paths: readonly string[]): Promise<{ files: PartialCommitFile[]; whole: string[] }> {
  const files: PartialCommitFile[] = [];
  const whole: string[] = [];
  const excludedHunks = useCommit.getState().excludedHunks;
  for (const path of paths) {
    const [head, disk] = await Promise.all([call(commands.vcsFileAt(path, "HEAD")), call(commands.fsReadText(path))]);
    const hunks = await commands.vcsDiffHunks(head ?? "", disk);
    const keys = hunkKeys(disk, hunks);
    const excluded = excludedHunks.get(path) ?? excludedHunks.get(`${path}/`);
    const chosen = hunks.filter((_, i) => !excluded?.has(keys[i]!));
    if (chosen.length === hunks.length) whole.push(path);
    else
      files.push({
        path,
        hunks: chosen.map(({ start, lines, oldStart, oldLines }) => ({ start, lines, oldStart, oldLines })),
      });
  }
  return { files, whole };
}

/**
 * `plan` per repository with the Commit Options, as `vcs_commit` gets it. Read from disk:
 * the caller saved the editors and refreshed the status.
 */
export async function selectionOf(plan: CommitPlan): Promise<CommitSelection> {
  const rev = revision;
  const { message, amend, signOff, author, runHooks } = useCommit.getState();
  const partial = await partialCommitFiles(plan.partial);
  // Like IDEA, every repository with included changes gets a commit with the same message.
  const roots = useVcs.getState().roots;
  const repos = commitRepos(plan.included, roots, currentRepo());
  // The commit is made from a copy of the index, so changes left out keep their
  // staged state and the other repositories' indexes stay as they are.
  const stage = [...plan.stage, ...partial.whole];
  const fallback = useVcs.getState().root ?? "";
  const repositories = repos.map((repo) => {
    const inRepo = (path: string) => repos.length === 1 || (rootOf(path, roots) ?? null) === repo;
    const options: CommitOptions = {
      amend,
      signOff,
      author: author.trim() || null,
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

export function provideCommit(): () => void {
  provideCommitService({
    selection: pendingSelection,
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
