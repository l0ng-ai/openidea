import type { Commit } from "@/bindings";
import type { LogOptions } from "./logOptions";
import { commitRepo } from "./multiRoot";
import { formatTime } from "./model";

export function visibleCommitText(c: Commit, options: LogOptions): string[] {
  return [
    c.summary,
    c.refs.join(" "),
    ...(options.showRepository ? [commitRepo(c) ?? ""] : []),
    ...(options.showAuthor ? [c.author] : []),
    ...(options.showDate ? [formatTime(options.commitTimestamp ? (c.commitTimeMs ?? c.timeMs) : c.timeMs)] : []),
    ...(options.showHash ? [c.shortId] : []),
  ];
}

/** Case-insensitive word/subsequence matching; columns never form an artificial word. */
export function speedMatches(query: string, columns: readonly string[]): boolean {
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) =>
      columns.some((column) => {
        let next = 0;
        for (const c of column.toLocaleLowerCase()) if (c === word[next]) next++;
        return next === word.length;
      }),
    );
}

export function nextSpeedMatch(
  commits: readonly Commit[],
  query: string,
  options: LogOptions,
  from: number,
  direction = 1,
) {
  for (let step = 1; step <= commits.length; step++) {
    const i = (from + direction * step + commits.length * 2) % commits.length;
    if (speedMatches(query, visibleCommitText(commits[i]!, options))) return i;
  }
  return -1;
}
