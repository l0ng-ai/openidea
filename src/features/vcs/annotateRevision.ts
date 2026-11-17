/**
 * Annotating a file as of an earlier revision (IDEA's annotate family): the file at the first
 * parent of the annotated line's commit, or at a revision the user picks. Shown as a diff so the
 * change stays visible; the left pane is annotated by the viewer provider in
 * `annotateRevisionProvider`.
 */
import type { Commit } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import type { DiffData } from "./diffInput";
import { openDiff } from "./diffInput";
import { repositoryPath } from "./repositoryPaths";
import { repoOf } from "./store";

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

function notifyFailure(e: unknown): void {
  notifications().notify({
    group: "vcs",
    level: "error",
    title: tx("Cannot annotate"),
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
