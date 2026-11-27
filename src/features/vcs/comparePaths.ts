import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { chooseRepositoryRevision } from "./RevisionChooser";
import { openVcsDiff } from "./diffInput";
import { GITLINK_MODE, loadDiffEntries } from "./gitDiffEntries";
import { showPathComparison } from "./operations";
import { displayPath } from "./compare";
import { statusOf } from "./store";

export async function comparePathsWithRevision(paths: string[], revision?: string) {
  const scope = await call(commands.vcsCompareScope(paths));
  if (!scope.repositories.length) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "Selection is outside Git repositories",
      body: scope.skippedPaths.map((path) => displayPath(path)).join("\n"),
    });
    return;
  }
  const choice = revision
    ? { rev: revision, repositories: null }
    : await chooseRepositoryRevision(tx("Compare with Branch or Revision"), {
        repositories: scope.repositories,
        tags: true,
      });
  if (!choice) return;
  if (scope.singleFile && !revision) {
    await openVcsDiff({
      path: paths[0]!,
      left: { type: "rev", rev: choice.rev, label: choice.rev },
      right: { type: "worktree" },
    });
  } else {
    // A shared branch reviews the selection, including explicit errors for roots lacking it.
    const repositories = choice.repositories && choice.repositories.length === 1 ? choice.repositories : null;
    showPathComparison(paths, choice.rev, repositories);
  }
}

/** Changed submodule entries use the file diff even when their checkout is a directory. */
export async function showDirectoryWorkingDiff(paths: string[]): Promise<boolean> {
  const scope = await call(commands.vcsCompareScope(paths));
  if (scope.singleFile) return false;
  if (paths.length && paths.every((path) => statusOf(path))) {
    const entries = await loadDiffEntries(paths.flatMap((path) => ["WT", ":0", "HEAD"].map((rev) => ({ path, rev }))));
    if (entries?.some((entry) => entry?.mode === GITLINK_MODE)) return false;
  }
  if (!scope.repositories.length) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "Selection is outside Git repositories",
      body: scope.skippedPaths.map((path) => displayPath(path)).join("\n"),
    });
  } else showPathComparison(paths, "HEAD", null);
  return true;
}
