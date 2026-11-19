/**
 * Annotating a file as of an earlier revision (IDEA's annotate family): the file at the first
 * parent of the annotated line's commit, or at a revision the user picks. Shown as a diff so the
 * change stays visible; the left pane is annotated by the viewer provider in
 * `annotateRevisionProvider`.
 */
import type { Commit } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { relativePath } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import type { DiffData } from "./diffInput";
import { commitFileDiffData, openDiff } from "./diffInput";
import { repositoryPath } from "./repositoryPaths";
import { currentRepoRoot, repoOf } from "./store";

/** The diff that shows `commit` against its first parent; `null` for a root commit. */
export function previousRevisionDiffData(
  path: string,
  commit: Pick<Commit, "id" | "shortId" | "parents">,
): DiffData | null {
  const parent = commit.parents[0];
  if (!parent) return null;
  return {
    path,
    left: { type: "rev", rev: parent, label: parent.slice(0, 8) },
    right: { type: "rev", rev: commit.id, label: commit.shortId },
    annotateLeft: true,
  };
}

/**
 * The diff of `commit` (or any revision) against the working file, annotated on the left.
 * `historyPath` follows a rename: the file had another name at that revision.
 */
export function revisionDiffData(
  path: string,
  repo: string | null,
  commit: Pick<Commit, "id" | "shortId"> & { historyPath?: string | null },
): DiffData {
  const history = commit.historyPath ? repositoryPath(repo, commit.historyPath) : path;
  return {
    path,
    left: { type: "rev", rev: commit.id, label: commit.shortId, path: history },
    right: { type: "worktree" },
    annotateLeft: true,
  };
}

function notifyFailure(e: unknown, title = tx("Cannot annotate")): void {
  notifications().notify({
    group: "vcs",
    level: "error",
    title,
    body: e instanceof Error ? e.message : String(e),
  });
}

/** Opens `commit` against the working file, annotated on that side. */
export async function annotateAtRevision(
  path: string,
  commit: Pick<Commit, "id" | "shortId"> & { historyPath?: string | null },
): Promise<void> {
  try {
    await openDiff(revisionDiffData(path, repoOf(path), commit), { preview: false });
  } catch (e) {
    notifyFailure(e);
  }
}

/**
 * Opens the previous revision of `commit`, annotated: the line's history before the change. The
 * diff opens at its first change: the annotated line's number belongs to the working copy, not to
 * either revision.
 */
export async function annotatePreviousRevision(path: string, commit: string): Promise<void> {
  const repo = repoOf(path);
  try {
    const [found] = await call(
      commands.vcsLog(repo, { branch: commit, path: null, author: null, text: null, skip: 0, limit: 1 }),
    );
    const data = found ? previousRevisionDiffData(path, found) : null;
    if (!data) {
      notifications().notify({
        group: "vcs",
        level: "info",
        title: tx("No Previous Revision"),
        body: tx`${commit.slice(0, 8)} is the first commit of the file.`,
      });
      return;
    }
    await openDiff(data, { preview: false });
  } catch (e) {
    notifyFailure(e);
  }
}

/**
 * The annotate gutter's Show Diff (IDEA's): what `commit` changed in the file, against its first
 * parent, so a file the commit added or renamed shows as such. The file's history gives its name
 * at that commit when it was renamed later.
 */
export async function showRevisionDiff(path: string, commit: string): Promise<void> {
  const repo = repoOf(path) ?? currentRepoRoot();
  if (!repo) return;
  const relative = relativePath(ipcPath(repo).replace(/\/$/, ""), ipcPath(path));
  const log = (file: string | null) =>
    call(
      commands.vcsLog(repo, {
        branch: commit,
        path: file,
        follow: !!file,
        author: null,
        text: null,
        skip: 0,
        limit: 1,
      }),
    );
  try {
    const [[inHistory], files] = await Promise.all([log(path), call(commands.vcsCommitFiles(repo, commit))]);
    // A line's commit is in its file's history; a merge commit may not be, so read it directly then.
    const found = inHistory?.id === commit ? inHistory : (await log(null))[0];
    if (!found) return;
    const name = (found === inHistory && found.historyPath) || relative;
    const changed = files.find((f) => f.path === name) ?? { path: name, kind: "modified", oldPath: null };
    await openDiff(commitFileDiffData({ ...found, repo }, changed), { preview: false });
  } catch (e) {
    notifyFailure(e, tx("Could not show diff"));
  }
}
