/** Annotate's ignore list: the commits `git blame --ignore-revs-file` skips. */

/** Git's conventional name for the list, at the repository root. */
export const BLAME_IGNORE_REVS_FILE = ".git-blame-ignore-revs";

/**
 * `existing` (the ignore list's text, `""` when there is no file yet) with `commit`
 * appended: every existing line keeps its text and order, a commit that is already
 * listed (surrounding spaces aside) is not repeated, revisions stay one per line and
 * the result ends with a newline. Line endings follow the existing text.
 */
export function appendIgnoreRevision(existing: string, commit: string): string {
  const revision = commit.trim();
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing ? existing.split(/\r?\n/) : [];
  // The trailing newline is put back below; keep the line before it.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (revision && !lines.some((line) => line.trim() === revision)) lines.push(revision);
  return lines.length ? lines.join(newline) + newline : "";
}
