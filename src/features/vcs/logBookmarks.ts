import type { Commit } from "@/bindings";
import { commitRepo } from "./multiRoot";

/** Stable virtual bookmark target; uses the platform's groups, mnemonic and description model. */
export const commitBookmarkPath = (commit: Commit) =>
  `git-log:${encodeURIComponent(commitRepo(commit) ?? "")}#${commit.id}`;
export function parseCommitBookmark(path: string): { repo: string; id: string } | null {
  if (!path.startsWith("git-log:")) return null;
  const [repo, id] = path.slice(8).split("#");
  if (!id) return null;
  try {
    return { repo: decodeURIComponent(repo!), id };
  } catch {
    return null;
  }
}
