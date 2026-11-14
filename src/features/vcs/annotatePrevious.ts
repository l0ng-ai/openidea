/**
 * Annotate Previous Revision (IDEA): the file as it was at the first parent of the
 * annotated line's commit, annotated by that history. Shown as a diff against the
 * commit so the change that introduced the line stays visible; the left pane is
 * annotated by the viewer provider in `annotatePreviousProvider`.
 */
import type { Commit } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import type { DiffData } from "./diffInput";
import { openDiff } from "./diffInput";
import { repoOf } from "./store";

/** The diff that shows `commit` against its first parent; `null` for a root commit. */
export function previousRevisionDiffData(
  path: string,
  commit: Pick<Commit, "id" | "shortId" | "parents">,
  line?: number,
): DiffData | null {
  const parent = commit.parents[0];
  if (!parent) return null;
  return {
    path,
    left: { type: "rev", rev: parent, label: parent.slice(0, 8) },
    right: { type: "rev", rev: commit.id, label: commit.shortId },
    ...(line === undefined ? {} : { line, lineSide: "right" as const }),
    annotateLeft: true,
  };
}

/** Opens the previous revision of `commit`, annotated: the line's history before the change. */
export async function annotatePreviousRevision(path: string, commit: string, line?: number): Promise<void> {
  const repo = repoOf(path);
  try {
    const [found] = await call(
      commands.vcsLog(repo, { branch: commit, path: null, author: null, text: null, skip: 0, limit: 1 }),
    );
    const data = found ? previousRevisionDiffData(path, found, line) : null;
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
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx("Cannot annotate"),
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
