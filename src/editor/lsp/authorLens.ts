/**
 * Code vision "author" hint beside the usages lens (IDEA's "Thomas +2"): the
 * author of the latest commit touching a declaration's lines, plus how many
 * other people changed them. Blame comes from `vcs_blame`, cached per file
 * and document text; a VCS change (commit, checkout, …) drops the cache.
 */
import type { Text } from "@codemirror/state";
import { call, commands, isTauri, onIdeEvent, type BlameLine } from "@/platform/ipc";

export interface AuthorSummary {
  author: string;
  /** Other distinct authors of the range. */
  others: number;
  /** Every distinct author, latest change first. */
  authors: string[];
}

const isUncommitted = (l: BlameLine) => /^0+$/.test(l.commit);

/** Authors of 0-based lines `from..=to`; null when none of them is committed. */
export function authorSummary(blame: readonly BlameLine[], from: number, to: number): AuthorSummary | null {
  const latest = new Map<string, number>();
  for (let i = Math.max(0, from); i <= to && i < blame.length; i++) {
    const l = blame[i]!;
    if (isUncommitted(l) || !l.author) continue;
    const t = l.timeMs ?? 0;
    if ((latest.get(l.author) ?? -Infinity) < t) latest.set(l.author, t);
  }
  if (!latest.size) return null;
  const authors = [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  return { author: authors[0]!, others: authors.length - 1, authors };
}

export function authorLabel(s: AuthorSummary): string {
  return s.others ? `${s.author} +${s.others}` : s.author;
}

export function authorTooltip(s: AuthorSummary): string {
  return s.others
    ? `Last changed by ${s.author}; also ${s.authors.slice(1).join(", ")}`
    : `Last changed by ${s.author}`;
}

interface Entry {
  text: Text | null;
  lines: Promise<BlameLine[] | null>;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let offVcs: (() => void) | null = null;

/** Drops cached blame and tells editors to fetch it again (VCS changes). */
export function clearBlameCache() {
  cache.clear();
  listeners.forEach((l) => l());
}

function watchVcs() {
  if (!offVcs && isTauri()) offVcs = onIdeEvent("vcsChanged", clearBlameCache);
}

/** Called after a VCS change made cached blame stale; returns the unsubscribe function. */
export function onBlameInvalidated(listener: () => void): () => void {
  watchVcs();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Blame of `path` for the document `text`; null when the file isn't under
 * version control (remembered until the next VCS change).
 */
export function blameFor(path: string, text: Text): Promise<BlameLine[] | null> {
  watchVcs();
  const hit = cache.get(path);
  if (hit && (hit.text === text || hit.text === null)) return hit.lines;
  const entry: Entry = { text, lines: Promise.resolve(null) };
  entry.lines = call(commands.vcsBlame(path, null, null)).then(
    (lines) => lines,
    () => {
      entry.text = null;
      return null;
    },
  );
  cache.set(path, entry);
  return entry.lines;
}
