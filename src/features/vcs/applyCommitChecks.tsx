import type { ApplyCommitOptions, ApplyCommitReview, CommitSelection, StagedTextEdit, TextEdit } from "@/bindings";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { CommitCheckSummary } from "./CommitCheckSummary";
import { prepareSnapshotModifications, runCommitChecks, syncCommitEdits } from "./commitChecks";
import { contributedCheckProblems, draftRevision } from "./commitSelection";
import { baseName, stripSlash } from "./model";
import { errorMessage, logConsole, runOp } from "./ops";
import { refreshNow, useVcs } from "./store";

function stagedApplyFiles(review: ApplyCommitReview) {
  const paths = new Set(review.paths);
  return useVcs.getState().status.filter((file) => file.staged && paths.has(stripSlash(file.path)));
}

interface WorkingFormat {
  path: string;
  before: string;
  edits: TextEdit[];
}

export async function modifyReviewedApply(root: string, review: ApplyCommitReview, isCurrent: () => boolean) {
  const mods = workflowSettings().vcs.commit;
  if (!mods.reformat && !mods.optimizeImports && !mods.cleanup) return review;
  return runOp(
    mods.reformat ? "Reformat code" : mods.optimizeImports ? "Optimize imports" : "Cleanup",
    async () => {
      const staged: StagedTextEdit[] = [];
      const working: WorkingFormat[] = [];
      for (const file of stagedApplyFiles(review)) {
        if (!isCurrent()) return;
        if (file.staged === "deleted") continue;
        const path = stripSlash(file.path);
        try {
          const before = await call(commands.vcsStagedText(path));
          if (!before) continue;
          const result = await prepareSnapshotModifications(file, before.text, mods, isCurrent);
          if (!result) continue;
          staged.push({ path, version: before.version, text: result.text });
          if (file.unstaged === null) working.push({ path, before: before.text, edits: result.edits });
        } catch (error) {
          logConsole("info", `Before-commit edits skipped for ${baseName(path)}: ${errorMessage(error)}`);
        }
      }
      if (!isCurrent()) return;
      if (!staged.length) return review;
      const updated = await call(commands.vcsFormatApplyCommit(root, review.checkpoint, staged, nextRequestId()));
      if (updated.checkpoint === review.checkpoint) return review;
      for (const { path, before, edits } of working) {
        if (!isCurrent()) return;
        try {
          await syncCommitEdits(path, before, edits, isCurrent);
        } catch (error) {
          logConsole("info", `Before-commit edits skipped for ${baseName(path)}: ${errorMessage(error)}`);
        }
      }
      await refreshNow();
      return updated;
    },
    { refresh: false },
  );
}

export async function checkReviewedApply(
  root: string,
  review: ApplyCommitReview,
  message: string,
  options: ApplyCommitOptions,
  isCurrent: () => boolean,
): Promise<boolean> {
  const staged = stagedApplyFiles(review).map((file) => ({ ...file, unstaged: null }));
  const selection: CommitSelection = {
    revision: draftRevision(),
    message: message.trim(),
    amend: false,
    repositories: [
      {
        root,
        options: {
          amend: false,
          author: options.author ?? null,
          authorDate: options.authorDate,
          runHooks: options.runHooks ?? true,
          signOff: options.signOff ?? false,
        },
      },
    ],
  };
  const result = await runOp(
    "Run Commit Checks",
    async () => {
      const checked = await runCommitChecks(staged, false, async () => selection, { root, status: staged });
      if (checked.blocked || !isCurrent()) return checked;
      const problems = await contributedCheckProblems(selection);
      return { problems: [...checked.problems, ...problems], blocked: problems.length > 0 };
    },
    { refresh: false, onError: (_message, error) => error instanceof DOMException && error.name === "AbortError" },
  );
  if (!result || !isCurrent()) return false;
  if (result.blocked) {
    const inspect = new AbortController();
    const choice = await ask({
      title: "Commit Checks",
      presentation: "form",
      width: 580,
      body: <CommitCheckSummary result={result} onInspect={() => inspect.abort()} />,
      signal: inspect.signal,
      buttons: [
        { id: "commit", label: "Commit Anyway" },
        { id: "cancel", label: "Cancel", primary: true },
      ],
    });
    return choice.button === "commit" && isCurrent();
  }
  if (result.problems.length)
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: "Commit Checks",
      body: <CommitCheckSummary result={result} />,
    });
  return true;
}
