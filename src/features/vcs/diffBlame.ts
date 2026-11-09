import type { DiffSide } from "./diffInput";

/** What `git blame` annotates a diff side with. */
export interface DiffBlameTarget {
  /** The file at that side's revision (it may have been renamed since). */
  path: string;
  /** Blame history; unset for the working file, which follows HEAD and edits like the editor's annotations. */
  revision?: string;
}

/**
 * The blame for one side of a diff: a revision blames its own history, the working file the
 * file on disk; Compare Files, Local History and plain texts are not Git content.
 * The index (`:0`) is not a revision `git blame` takes, so its text is blamed on HEAD and the
 * lines staged since show as not committed.
 */
export function diffBlameTarget(side: DiffSide, path: string, vcsAvailable: boolean): DiffBlameTarget | null {
  if (!vcsAvailable) return null;
  switch (side.type) {
    case "rev":
      return { path: side.path ?? path, revision: side.rev.startsWith(":") ? "HEAD" : side.rev };
    case "worktree":
      return { path };
    default:
      return null;
  }
}
